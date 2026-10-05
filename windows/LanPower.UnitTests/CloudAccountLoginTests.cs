using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using LanPower.Service;

namespace LanPower.UnitTests;

[TestClass]
public sealed class CloudAccountLoginTests
{
    private const string Origin = "https://accounts.example.test";
    private const string Password = "test account password 123!";
    private sealed class Store : ICloudCredentialStore
    {
        public CloudCredentials? Value;
        public CloudCredentials? Load() => Value;
        public void Save(CloudCredentials value) => Value = value;
        public void Delete() => Value = null;
    }
    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => respond(request);
    }
    private static object Payload(string id, string username = "alice") => new
    {
        device_id = id, refresh_token = new string('r', 43), access_token = new string('a', 43),
        access_expires_at = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 900,
        account = new { id = Guid.NewGuid().ToString(), username }
    };

    [TestMethod]
    public async Task LoginSendsExistingProofPreservesDeviceAndStoresNoPassword()
    {
        var id = Guid.NewGuid().ToString();
        var store = new Store { Value = new(Origin, id, new string('o', 43)) };
        using var http = new HttpClient(new Handler(async request =>
        {
            Assert.AreEqual(Origin + "/api/v2/account/login", request.RequestUri!.ToString());
            using var sent = await request.Content!.ReadFromJsonAsync<JsonDocument>();
            Assert.AreEqual("alice", sent!.RootElement.GetProperty("username").GetString());
            Assert.AreEqual("windows", sent.RootElement.GetProperty("client_type").GetString());
            Assert.AreEqual(id, sent.RootElement.GetProperty("previous").GetProperty("id").GetString());
            Assert.AreEqual(store.Value!.RefreshToken, sent.RootElement.GetProperty("previous").GetProperty("refresh_token").GetString());
            return new(HttpStatusCode.OK) { Content = JsonContent.Create(Payload(id)) };
        }));
        var tokens = new CloudTokenSession(http, store);
        var login = new CloudAccountLogin(http, store.Load, () => new string('k', 43), tokens.SaveAccountLoginAsync);
        await login.LoginAsync(Origin, " ALICE ", Password, CancellationToken.None);
        Assert.AreEqual(id, store.Value!.DeviceId);
        Assert.AreEqual("alice", store.Value.AccountUsername);
        Assert.IsFalse(JsonSerializer.Serialize(store.Value).Contains(Password, StringComparison.Ordinal));
    }

    [TestMethod]
    public async Task LateLoginCannotReplaceSwitchedCredentials()
    {
        var old = new CloudCredentials(Origin, Guid.NewGuid().ToString(), new string('o', 43));
        var switched = old with { DeviceId = Guid.NewGuid().ToString() };
        var store = new Store { Value = old };
        using var http = new HttpClient(new Handler(request =>
        {
            store.Value = switched;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(Payload(old.DeviceId)) });
        }));
        var tokens = new CloudTokenSession(http, store);
        var login = new CloudAccountLogin(http, store.Load, () => new string('k', 43), tokens.SaveAccountLoginAsync);
        await Assert.ThrowsExactlyAsync<CloudLoginException>(() => login.LoginAsync(Origin, "alice", Password, CancellationToken.None));
        Assert.AreEqual(switched, store.Value);
    }

    [TestMethod]
    [DataRow(401)]
    [DataRow(409)]
    [DataRow(429)]
    [DataRow(404)]
    [DataRow(503)]
    public async Task FailedLoginLeavesExistingCredentialsIntact(int status)
    {
        var existing = new CloudCredentials(Origin, Guid.NewGuid().ToString(), new string('o', 43));
        var store = new Store { Value = existing };
        using var http = new HttpClient(new Handler(request => Task.FromResult(new HttpResponseMessage((HttpStatusCode)status))));
        var tokens = new CloudTokenSession(http, store);
        var login = new CloudAccountLogin(http, store.Load, () => new string('k', 43), tokens.SaveAccountLoginAsync);
        await Assert.ThrowsExactlyAsync<CloudLoginException>(() => login.LoginAsync(Origin, "alice", Password, CancellationToken.None));
        Assert.AreEqual(existing, store.Value);
    }

    [TestMethod]
    public async Task InvalidCloudOrAccountResponseCannotSaveCredentials()
    {
        var store = new Store();
        using var http = new HttpClient(new Handler(request => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            { Content = JsonContent.Create(Payload(Guid.NewGuid().ToString(), "bob")) })));
        var tokens = new CloudTokenSession(http, store);
        var login = new CloudAccountLogin(http, store.Load, () => new string('k', 43), tokens.SaveAccountLoginAsync);
        await Assert.ThrowsExactlyAsync<ArgumentException>(() => login.LoginAsync("http://accounts.example.test", "alice", Password, CancellationToken.None));
        await Assert.ThrowsExactlyAsync<InvalidDataException>(() => login.LoginAsync(Origin, "alice", Password, CancellationToken.None));
        Assert.IsNull(store.Value);
    }

    [TestMethod]
    public void InstallationKeyIsEncryptedStableAndRemovedOnLogout()
    {
        var folder = Path.Combine(Path.GetTempPath(), "LanPowerAccountTests", Guid.NewGuid().ToString("N"));
        try
        {
            var store = new CloudCredentialStore(folder);
            var key = store.AccountConnectionKey();
            Assert.AreEqual(43, key.Length);
            Assert.AreEqual(key, new CloudCredentialStore(folder).AccountConnectionKey());
            Assert.IsFalse(System.Text.Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(folder, "account-key.dat"))).Contains(key, StringComparison.Ordinal));
            store.Delete();
            Assert.AreNotEqual(key, store.AccountConnectionKey());
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }
}
