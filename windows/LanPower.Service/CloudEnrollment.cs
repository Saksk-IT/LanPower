using System.Net.Http.Json;
using System.Text.Json;
using LanPower.Shared;

namespace LanPower.Service;

// The device code stays in the service. The desktop only receives a local handle
// and the short code that the user can compare with the Cloud approval page.
public sealed class CloudEnrollment(HttpClient client,
    Func<string, JsonElement, CancellationToken, Task> saveTokens, TimeProvider? clock = null)
{
    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private CloudPairing? _pairing;
    private string? _deviceCode;
    private string _origin = "";
    private string _state = "pending";
    private long _nextPoll;
    private JsonElement? _approved;

    public static string NormalizeOrigin(string cloudUrl)
    {
        if (cloudUrl.Length > 250 || !Uri.TryCreate(cloudUrl, UriKind.Absolute, out var uri) ||
            !CloudOrigin.IsAllowed(uri) || uri.AbsolutePath != "/" ||
            uri.Query.Length != 0 || uri.Fragment.Length != 0)
            throw new ArgumentException("Cloud 需使用 HTTPS；本机和私有局域网 IP 可使用 HTTP");
        return uri.GetLeftPart(UriPartial.Authority);
    }

    public async Task<CloudPairing> BeginAsync(string cloudUrl, CancellationToken token)
    {
        var origin = NormalizeOrigin(cloudUrl);
        await _lock.WaitAsync(token);
        try
        {
            using var response = await client.PostAsJsonAsync(origin + "/api/v2/enroll/start",
                new { device_type = "windows", name = Environment.MachineName, version = LanProtocol.Version, protocol_version = "2" }, token);
            response.EnsureSuccessStatusCode();
            using var data = await response.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: token)
                ?? throw new InvalidDataException("Cloud 配对响应无效");
            var result = data.RootElement;
            var deviceCode = result.GetProperty("device_code").GetString() ?? "";
            var userCode = result.GetProperty("user_code").GetString() ?? "";
            var verification = result.GetProperty("verification_uri").GetString() ?? "";
            var expires = result.GetProperty("expires_in").GetInt32();
            var interval = result.GetProperty("interval").GetInt32();
            if (deviceCode.Length is < 32 or > 128 || userCode.Length != 9 || userCode[4] != '-' ||
                userCode.Where((_, index) => index != 4).Any(c => !char.IsAsciiLetterUpper(c) && !char.IsAsciiDigit(c)) ||
                verification != origin + "/enroll" || expires is < 1 or > 900 || interval is < 1 or > 30)
                throw new InvalidDataException("Cloud 配对响应无效");
            _pairing = new CloudPairing(Guid.NewGuid(), userCode, verification,
                _clock.GetUtcNow().ToUnixTimeSeconds() + expires, interval);
            _deviceCode = deviceCode;
            _origin = origin;
            _nextPoll = 0;
            _state = "pending";
            _approved = null;
            return _pairing;
        }
        finally { _lock.Release(); }
    }

    public async Task<string> PollAsync(Guid id, CancellationToken token)
    {
        await _lock.WaitAsync(token);
        try
        {
            if (_pairing is null || _pairing.Id != id) return "expired";
            if (_state != "pending") return _state;
            var now = _clock.GetUtcNow().ToUnixTimeSeconds();
            if (_approved is null)
            {
                if (now >= _pairing.ExpiresAt) return Complete("expired");
                if (now < _nextPoll) return "pending";
                _nextPoll = now + _pairing.Interval;
                using var response = await client.PostAsJsonAsync(_origin + "/api/v2/enroll/token",
                    new { device_code = _deviceCode }, token);
                using var data = await response.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: token)
                    ?? throw new InvalidDataException("Cloud 配对响应无效");
                if (!response.IsSuccessStatusCode)
                {
                    return data.RootElement.GetProperty("error").GetString() switch
                    {
                        "authorization_pending" => "pending",
                        "slow_down" => "pending",
                        "access_denied" => Complete("denied"),
                        "expired_token" or "invalid_grant" => Complete("expired"),
                        _ => throw new InvalidOperationException("Cloud 配对暂时不可用")
                    };
                }
                _approved = data.RootElement.Clone();
            }
            // Keep the response in memory until the encrypted credential file is
            // durable, so an interrupted local write does not repeat the exchange.
            await saveTokens(_origin, _approved.Value, token);
            return Complete("connected");
        }
        finally { _lock.Release(); }
    }

    private string Complete(string state)
    {
        _deviceCode = null;
        _approved = null;
        return _state = state;
    }

    public async Task CancelAsync(Guid? id, CancellationToken token)
    {
        await _lock.WaitAsync(token);
        try
        {
            if (id is not null && _pairing?.Id != id) return;
            _pairing = null;
            Complete("expired");
        }
        finally { _lock.Release(); }
    }
}
