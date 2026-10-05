using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using LanPower.Shared;

namespace LanPower.Service;

public sealed class CloudLoginException(string message) : InvalidOperationException(message);

public sealed class CloudAccountLogin(HttpClient client, Func<CloudCredentials?> load,
    Func<string> connectionKey,
    Func<string, JsonElement, CloudCredentials?, CancellationToken, Task> save)
{
    private readonly SemaphoreSlim _lock = new(1, 1);

    public async Task LoginAsync(string cloudUrl, string username, string password, CancellationToken token)
    {
        var origin = CloudEnrollment.NormalizeOrigin(cloudUrl);
        username = username.Trim().ToLowerInvariant();
        if (username.Length is < 1 or > 80 || password.Length is < 1 or > 256)
            throw new CloudLoginException("请填写账号和密码");
        await _lock.WaitAsync(token);
        try
        {
            var previous = load();
            if (previous is not null && previous.CloudUrl != origin)
                throw new CloudLoginException("请先退出当前 Cloud，再登录其他 Cloud");
            var key = connectionKey();
            var body = new Dictionary<string, object>
            {
                ["username"] = username, ["password"] = password, ["client_type"] = "windows",
                ["connection_key"] = key, ["name"] = Environment.MachineName,
                ["version"] = LanProtocol.Version, ["protocol_version"] = "2"
            };
            if (previous is not null)
                body["previous"] = new { id = previous.DeviceId, refresh_token = previous.RefreshToken };
            using var response = await client.PostAsJsonAsync(origin + "/api/v2/account/login", body, token);
            if (!response.IsSuccessStatusCode)
            {
                var message = response.StatusCode switch
                {
                    HttpStatusCode.Unauthorized => "账号或密码不正确；已有 Passkey 账号请先在网页设置密码",
                    HttpStatusCode.Conflict => "当前连接属于其他账号或凭据已失效，请先退出当前账号",
                    HttpStatusCode.TooManyRequests => "尝试次数过多，请在 5 分钟后重试",
                    HttpStatusCode.NotFound or HttpStatusCode.MethodNotAllowed => "请先将 Cloud 更新到支持统一账号的版本",
                    _ => "登录暂时不可用，请检查 Cloud 地址后重试"
                };
                throw new CloudLoginException(message);
            }
            using var data = await response.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: token)
                ?? throw new InvalidDataException("Cloud 登录响应无效");
            var account = data.RootElement.GetProperty("account");
            if (account.GetProperty("username").GetString() != username || !Guid.TryParseExact(account.GetProperty("id").GetString(), "D", out _))
                throw new InvalidDataException("Cloud 账号响应无效");
            if (connectionKey() != key) throw new CloudLoginException("连接已变化，请重新登录");
            await save(origin, data.RootElement, previous, token);
        }
        finally { _lock.Release(); }
    }
}
