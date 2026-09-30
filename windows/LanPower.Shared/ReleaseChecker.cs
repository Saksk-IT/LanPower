using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LanPower.Shared;

public sealed record ReleaseInfo(string Version, bool UpdateAvailable, string PageUrl);

public static partial class ReleaseChecker
{
    public const string ApiUrl = "https://api.github.com/repos/Saksk-IT/LanPower/releases/latest";
    private const string ReleaseBase = "https://github.com/Saksk-IT/LanPower/releases/tag/";

    public static async Task<ReleaseInfo?> CheckAsync(HttpClient client, string currentVersion, CancellationToken token)
    {
        var current = ParseVersion(currentVersion);
        using var request = new HttpRequestMessage(HttpMethod.Get, ApiUrl);
        request.Headers.UserAgent.Add(new ProductInfoHeaderValue("LanPower", currentVersion));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        request.Headers.Add("X-GitHub-Api-Version", "2026-03-10");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        await response.Content.LoadIntoBufferAsync(256 * 1024, token);
        using var body = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(token), cancellationToken: token);
        var data = body.RootElement;
        var tag = data.GetProperty("tag_name").GetString() ?? "";
        if (data.GetProperty("draft").GetBoolean() || data.GetProperty("prerelease").GetBoolean())
            throw new InvalidDataException("发布信息无效");
        var latest = ParseVersion(tag);
        var page = ReleaseBase + Uri.EscapeDataString(tag);
        if (!string.Equals(data.GetProperty("html_url").GetString(), page, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("发布地址无效");
        return new ReleaseInfo(tag.TrimStart('v'), latest > current, page);
    }

    private static Version ParseVersion(string value)
    {
        if (!StableVersion().IsMatch(value) || !Version.TryParse(value.TrimStart('v'), out var parsed))
            throw new InvalidDataException("版本信息无效");
        return parsed;
    }

    [GeneratedRegex("^v?(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$", RegexOptions.CultureInvariant)]
    private static partial Regex StableVersion();
}
