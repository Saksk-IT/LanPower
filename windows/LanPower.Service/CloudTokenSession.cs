using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace LanPower.Service;

public sealed class CloudReconnectRequiredException() : UnauthorizedAccessException("需要重新连接 Cloud");

public sealed record CloudAccess(CloudCredentials Credentials, string Token);
public sealed record CloudDisconnected(CloudCredentials? Credentials, string? AccessToken);

// Refresh tokens are single-use. Persist an intent before sending one, and never
// repeat the exchange after a lost response or a process restart. If only the
// final local write failed, retain the response and retry that write in memory.
public sealed class CloudTokenSession(HttpClient client, ICloudCredentialStore store, TimeProvider? clock = null)
{
    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private CloudCredentials? _active;
    private string? _access;
    private long _expires;
    private PendingTokens? _pending;

    private sealed record PendingTokens(CloudCredentials Previous, CloudCredentials Updated, string Access, long Expires);

    public static void ValidateCredentials(CloudCredentials saved)
    {
        if (saved.CloudUrl is null || CloudEnrollment.NormalizeOrigin(saved.CloudUrl) != saved.CloudUrl ||
            !Guid.TryParseExact(saved.DeviceId, "D", out _) || !ValidToken(saved.RefreshToken))
            throw new InvalidDataException("Cloud 凭据无效");
    }

    private static bool ValidToken(string? value) => value is { Length: >= 32 and <= 128 } &&
        value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    private (CloudCredentials Credentials, string Access, long Expires) Parse(string origin, JsonElement payload)
    {
        var deviceId = payload.GetProperty("device_id").GetString();
        var refresh = payload.GetProperty("refresh_token").GetString();
        var access = payload.GetProperty("access_token").GetString();
        var expires = payload.GetProperty("access_expires_at").GetInt64();
        if (!Guid.TryParseExact(deviceId, "D", out _) || !ValidToken(refresh) || !ValidToken(access) ||
            expires <= _clock.GetUtcNow().ToUnixTimeSeconds() || expires > _clock.GetUtcNow().ToUnixTimeSeconds() + 3600)
            throw new InvalidDataException("Cloud 凭据响应无效");
        return (new CloudCredentials(origin, deviceId!, refresh!), access!, expires);
    }

    public async Task SaveEnrollmentAsync(string origin, JsonElement payload, CancellationToken token)
    {
        origin = CloudEnrollment.NormalizeOrigin(origin);
        var result = Parse(origin, payload);
        await _lock.WaitAsync(token);
        try
        {
            store.Save(result.Credentials);
            _pending = null;
            _active = result.Credentials;
            _access = result.Access;
            _expires = result.Expires;
        }
        finally { _lock.Release(); }
    }

    public async Task<CloudAccess> GetAccessAsync(CancellationToken token)
    {
        await _lock.WaitAsync(token);
        try
        {
            var saved = store.Load() ?? throw new InvalidDataException("Cloud 未配置");
            ValidateCredentials(saved);
            if (_pending is not null)
            {
                if (saved == (_pending.Previous with { RefreshPending = true }))
                    return CommitPending();
                _pending = null;
            }
            if (saved.RefreshPending) throw new CloudReconnectRequiredException();
            if (saved == _active && _access is not null && _expires > _clock.GetUtcNow().ToUnixTimeSeconds() + 60)
                return new CloudAccess(saved, _access);

            token.ThrowIfCancellationRequested();
            // A failed intent write must prevent the HTTP exchange altogether.
            store.Save(saved with { RefreshPending = true });
            _active = null;
            _access = null;
            HttpResponseMessage exchanged;
            try
            {
                exchanged = await client.PostAsJsonAsync(saved.CloudUrl + "/api/v2/windows/token",
                    new { device_id = saved.DeviceId, refresh_token = saved.RefreshToken }, token);
            }
            catch (HttpRequestException error) when (error.HttpRequestError == HttpRequestError.NameResolutionError)
            {
                // DNS failed before an HTTP request could reach Cloud. Retrying
                // is safe; a timeout or lost response still requires re-pairing.
                store.Save(saved);
                throw;
            }
            using var response = exchanged;
            if (response.StatusCode == HttpStatusCode.Unauthorized) throw new CloudReconnectRequiredException();
            response.EnsureSuccessStatusCode();
            using var data = await response.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: token)
                ?? throw new InvalidDataException("Cloud 凭据响应无效");
            var result = Parse(saved.CloudUrl, data.RootElement);
            if (result.Credentials.DeviceId != saved.DeviceId || result.Credentials.RefreshToken == saved.RefreshToken)
                throw new InvalidDataException("Cloud 凭据响应无效");
            _pending = new PendingTokens(saved, result.Credentials, result.Access, result.Expires);
            return CommitPending();
        }
        finally { _lock.Release(); }
    }

    private CloudAccess CommitPending()
    {
        var pending = _pending!;
        store.Save(pending.Updated);
        _active = pending.Updated;
        _access = pending.Access;
        _expires = pending.Expires;
        _pending = null;
        return new CloudAccess(_active, _access);
    }

    public async Task BlockAsync(CloudCredentials expected, CancellationToken token)
    {
        await _lock.WaitAsync(token);
        try
        {
            // An old connection's 401 must not disable a newly paired identity.
            if (store.Load() != expected) return;
            _pending = null;
            _active = null;
            _access = null;
            store.Save(expected with { RefreshPending = true });
        }
        finally { _lock.Release(); }
    }

    public async Task<CloudAccess?> GetCachedAccessAsync(CancellationToken token)
    {
        await _lock.WaitAsync(token);
        try
        {
            var saved = store.Load();
            return saved == _active && saved is not null && !saved.RefreshPending && _access is not null &&
                _expires > _clock.GetUtcNow().ToUnixTimeSeconds() ? new CloudAccess(saved, _access) : null;
        }
        finally { _lock.Release(); }
    }

    public async Task<CloudDisconnected> ClearAsync(CancellationToken token)
    {
        await _lock.WaitAsync(token);
        try
        {
            // Disconnect also works when the encrypted file cannot be decoded.
            CloudCredentials? saved;
            try { saved = store.Load(); }
            catch (Exception error) when (error is System.Security.Cryptography.CryptographicException or
                                          InvalidDataException or JsonException or ArgumentException) { saved = null; }
            var access = saved == _active && _expires > _clock.GetUtcNow().ToUnixTimeSeconds() ? _access : null;
            store.Delete();
            _pending = null;
            _active = null;
            _access = null;
            _expires = 0;
            return new CloudDisconnected(saved, access);
        }
        finally { _lock.Release(); }
    }
}
