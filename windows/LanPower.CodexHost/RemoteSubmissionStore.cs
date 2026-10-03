using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using LanPower.Shared;

namespace LanPower.CodexHost;

// Only receipts and hashes are persisted on the target computer. No prompt or attachment.
public sealed class RemoteSubmissionStore(string? path = null)
{
    private readonly string _path = path ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LanPower", "codex-submissions.json");
    private JsonObject? _entries;
    private const int Capacity = 512;

    private JsonObject Entries()
    {
        if (_entries is not null) return _entries;
        if (!File.Exists(_path)) return _entries = new();
        if (new FileInfo(_path).Length > 1024 * 1024) throw new IOException("submission_store_unavailable");
        _entries = JsonNode.Parse(File.ReadAllText(_path, Encoding.UTF8)) as JsonObject ?? throw new IOException("submission_store_unavailable");
        // A process restart cannot prove whether the original window accepted an in-flight call.
        foreach (var entry in _entries.Select(p => p.Value).OfType<JsonObject>())
            if (entry["state"]?.GetValue<string>() == "sending") entry["state"] = "uncertain";
        return _entries;
    }

    public JsonObject Read(string threadId, string submissionId)
    {
        var entries = Entries();
        if (entries[submissionId] is not JsonObject entry)
            return new() { ["submissionId"] = submissionId, ["threadId"] = threadId, ["state"] = "unknown" };
        if (entry["threadId"]?.GetValue<string>() != threadId) throw new InvalidDataException("submission_mismatch");
        var copy = (JsonObject)entry.DeepClone(); copy.Remove("hash"); return copy;
    }

    public async Task<bool> BeginAsync(string threadId, string submissionId, string method, JsonObject parameters, CancellationToken token)
    {
        var entries = Entries();
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(method + parameters.ToJsonString(CodexRemoteProtocol.JsonOptions))));
        if (entries[submissionId] is JsonObject existing)
        {
            if (existing["threadId"]?.GetValue<string>() != threadId || existing["hash"]?.GetValue<string>() != hash)
                throw new InvalidDataException("submission_mismatch");
            return false;
        }
        // Never evict a receipt whose outcome is still uncertain.
        while (entries.Count >= Capacity)
        {
            var oldest = entries.FirstOrDefault(p => p.Value?["state"]?.GetValue<string>() is "accepted" or "failed");
            if (oldest.Key is null) throw new InvalidDataException("submission_store_full");
            entries.Remove(oldest.Key);
        }
        entries[submissionId] = new JsonObject { ["threadId"] = threadId, ["submissionId"] = submissionId,
            ["method"] = method, ["hash"] = hash, ["state"] = "sending", ["updatedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        await SaveAsync(token); return true;
    }

    public async Task<JsonObject> FinishAsync(string threadId, string submissionId, JsonObject? response, CancellationToken token)
    {
        var entry = Entries()[submissionId]!.AsObject();
        var error = response?["error"] as JsonObject;
        var code = error?["code"]?.GetValue<int>();
        var category = error?["message"]?.GetValue<string>();
        // A transport/renderer failure can happen after dispatch. Only definitive rejections permit retry.
        entry["state"] = response is null ? "uncertain" : error is null ? "accepted" :
            code is -32601 or -32602 || category is "turn_changed" or "task_running" or "workspace_not_allowed" or "shared_runtime_required" ? "failed" : "uncertain";
        if (error is not null) entry["errorCode"] = code == -32601 ? "unsupported_method" : "request_rejected";
        entry["turnId"] = (response?["result"]?["turn"]?["id"] ?? response?["result"]?["turnId"])?.DeepClone();
        entry["queuedSubmissionId"] = response?["result"]?["queuedSubmission"]?["id"]?.DeepClone();
        entry["updatedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await SaveAsync(token); return Read(threadId, submissionId);
    }

    private async Task SaveAsync(CancellationToken token)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temporary = _path + ".tmp";
        await File.WriteAllTextAsync(temporary, Entries().ToJsonString(), new UTF8Encoding(false), token);
        File.Move(temporary, _path, true);
    }
}
