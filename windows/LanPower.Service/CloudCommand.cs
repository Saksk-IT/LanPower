using System.Text.Json;
using LanPower.Shared;

namespace LanPower.Service;

public sealed record CloudCommand(Guid Id, string TargetDeviceId, string Action, long IssuedAt, long ExpiresAt, string Nonce)
{
    public static CloudCommand Parse(JsonElement value, string deviceId, DateTimeOffset now)
    {
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() != 6)
            throw new InvalidDataException("云端命令格式无效");
        var id = Guid.Parse(value.GetProperty("command_id").GetString()!);
        var target = value.GetProperty("target_device_id").GetString()!;
        var action = value.GetProperty("action").GetString()!;
        var issued = value.GetProperty("issued_at").GetInt64();
        var expires = value.GetProperty("expires_at").GetInt64();
        var nonce = value.GetProperty("nonce").GetString()!;
        var nowSeconds = now.ToUnixTimeSeconds();
        if (target != deviceId || action != "status" && !LanProtocol.IsPowerAction(action) ||
            issued > nowSeconds + 60 || expires <= nowSeconds || expires - issued > 90 ||
            nonce.Length != 32 || !nonce.All(Uri.IsHexDigit))
            throw new InvalidDataException("云端命令未通过校验");
        return new CloudCommand(id, target, action, issued, expires, nonce);
    }
}

public sealed record StoredCommand(string CommandId, string Nonce, bool Ok, string State, string Error, bool Executed);

public sealed class ReplayStore
{
    private readonly string _path;
    private readonly object _sync = new();
    private readonly Dictionary<string, StoredCommand> _entries = new(StringComparer.Ordinal);
    private bool _corrupt;

    public ReplayStore(string dataDirectory)
    {
        Directory.CreateDirectory(dataDirectory);
        _path = Path.Combine(dataDirectory, "cloud-replay.jsonl");
        if (File.Exists(_path))
        {
            foreach (var line in File.ReadLines(_path))
            {
                try
                {
                    var entry = JsonSerializer.Deserialize<StoredCommand>(line)
                        ?? throw new InvalidDataException("Cloud 命令记录无效");
                    _entries[entry.CommandId] = entry;
                }
                catch (Exception error) when (error is JsonException or InvalidDataException)
                {
                    _corrupt = true;
                    break;
                }
            }
        }
    }

    public StoredCommand Prepare(CloudCommand command, bool accepted)
    {
        lock (_sync)
        {
            if (_corrupt) throw new InvalidDataException("Cloud 命令记录需要修复");
            var key = command.Id.ToString();
            if (_entries.TryGetValue(key, out var existing))
            {
                if (existing.Nonce != command.Nonce) throw new InvalidDataException("重复命令校验失败");
                return existing;
            }
            var entry = new StoredCommand(key, command.Nonce, accepted,
                accepted ? command.Action == "status" ? "online" : "transitioning" : "failed",
                accepted ? "" : "请稍后再执行电源操作", false);
            Append(entry);
            _entries[key] = entry;
            return entry;
        }
    }

    public StoredCommand? Find(CloudCommand command)
    {
        lock (_sync)
        {
            if (_corrupt) throw new InvalidDataException("Cloud 命令记录需要修复");
            if (!_entries.TryGetValue(command.Id.ToString(), out var existing)) return null;
            if (existing.Nonce != command.Nonce) throw new InvalidDataException("重复命令校验失败");
            return existing;
        }
    }

    public void MarkExecuted(StoredCommand entry)
    {
        lock (_sync)
        {
            if (_corrupt) throw new InvalidDataException("Cloud 命令记录需要修复");
            if (_entries[entry.CommandId].Executed) return;
            var updated = entry with { Executed = true };
            Append(updated);
            _entries[entry.CommandId] = updated;
        }
    }

    private void Append(StoredCommand entry)
    {
        using var stream = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.Read);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(entry);
        stream.Write(bytes);
        stream.WriteByte((byte)'\n');
        stream.Flush(true);
    }
}
