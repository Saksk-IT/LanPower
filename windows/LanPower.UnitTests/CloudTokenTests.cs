using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LanPower.Service;

namespace LanPower.UnitTests;

[TestClass]
public sealed class CloudTokenTests
{
    [TestMethod]
    public async Task ConcurrentRenewalsKeepThePairingAndShareOneAccessToken()
    {
        var store = new MemoryStore();
        var identity = store.Saved;
        using var handler = new RefreshHandler(store) { RenewalSupported = true };
        using var client = new HttpClient(handler);
        var session = new CloudTokenSession(client, store);
        var grants = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => session.GetAccessAsync(CancellationToken.None)));
        Assert.AreEqual(1, handler.Renewals);
        Assert.AreEqual(0, handler.Requests);
        Assert.AreEqual(identity, store.Load());
        Assert.IsTrue(grants.All(grant => grant == grants[0]));
    }

    [TestMethod]
    [DataRow("dns")]
    [DataRow("lost")]
    [DataRow("timeout")]
    [DataRow("server")]
    [DataRow("wrong_device")]
    [DataRow("expired")]
    [DataRow("rotated")]
    public async Task InterruptedRenewalRecoversAfterRestartWithoutLegacyRotation(string failure)
    {
        var store = new MemoryStore();
        var identity = store.Saved;
        using var handler = new RefreshHandler(store) { RenewalSupported = true, Failure = failure };
        using var client = new HttpClient(handler);
        var session = new CloudTokenSession(client, store);
        await Assert.ThrowsAsync<Exception>(() => session.GetAccessAsync(CancellationToken.None));
        Assert.AreEqual(identity, store.Load());
        handler.Failure = null;
        var restarted = new CloudTokenSession(client, store);
        var granted = await restarted.GetAccessAsync(CancellationToken.None);
        Assert.AreEqual(identity, granted.Credentials);
        Assert.AreEqual(2, handler.Renewals);
        Assert.AreEqual(0, handler.Requests, "Ambiguous renewal must never fall back to single-use rotation");
    }

    [TestMethod]
    public async Task CancellationDuringRenewalLeavesThePairingRetryable()
    {
        var store = new MemoryStore();
        var identity = store.Saved;
        using var handler = new RefreshHandler(store) { RenewalSupported = true, Failure = "pause" };
        using var client = new HttpClient(handler);
        var session = new CloudTokenSession(client, store);
        using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        await Assert.ThrowsAsync<OperationCanceledException>(() => session.GetAccessAsync(cancel.Token));
        Assert.AreEqual(identity, store.Load());
        handler.Failure = null;
        await new CloudTokenSession(client, store).GetAccessAsync(CancellationToken.None);
        Assert.AreEqual(0, handler.Requests);
    }

    [TestMethod]
    public async Task ResumeAfterAccessExpiryRenewsTheOriginalPairing()
    {
        var store = new MemoryStore();
        var identity = store.Saved;
        var clock = new Clock();
        using var handler = new RefreshHandler(store) { RenewalSupported = true, UtcNow = clock.GetUtcNow };
        using var client = new HttpClient(handler);
        var session = new CloudTokenSession(client, store, clock);
        await session.GetAccessAsync(CancellationToken.None);
        clock.Now += TimeSpan.FromHours(12);
        await session.GetAccessAsync(CancellationToken.None);
        Assert.AreEqual(identity, store.Load());
        Assert.AreEqual(2, handler.Renewals);
        Assert.AreEqual(0, handler.Requests);
    }

    [TestMethod]
    public async Task LateAccessRejectionCannotInvalidateANewerGrant()
    {
        var store = new MemoryStore();
        using var handler = new RefreshHandler(store) { RenewalSupported = true };
        using var client = new HttpClient(handler);
        var session = new CloudTokenSession(client, store);
        var old = await session.GetAccessAsync(CancellationToken.None);
        await session.InvalidateAccessAsync(old, CancellationToken.None);
        handler.AccessToken = new string('z', 43);
        var fresh = await session.GetAccessAsync(CancellationToken.None);
        await session.InvalidateAccessAsync(old, CancellationToken.None);
        Assert.AreEqual(fresh, await session.GetAccessAsync(CancellationToken.None));
        Assert.AreEqual(2, handler.Renewals);
        Assert.IsFalse(store.Saved!.ReconnectRequired);
    }

    [TestMethod]
    public async Task PendingLegacyIntentUsesSafeRenewalWhenTheTokenIsStillValid()
    {
        var store = new MemoryStore();
        store.Saved = store.Saved! with { RefreshPending = true };
        var original = store.Saved!;
        using var handler = new RefreshHandler(store) { RenewalSupported = true };
        using var client = new HttpClient(handler);
        var granted = await new CloudTokenSession(client, store).GetAccessAsync(CancellationToken.None);
        Assert.AreEqual(original with { RefreshPending = false }, granted.Credentials);
        Assert.AreEqual(0, handler.Requests);
    }

    [TestMethod]
    public async Task FailedRenewalSaveRetriesOnlyTheLocalWrite()
    {
        var store = new MemoryStore { FailWrite = _ => true };
        using var handler = new RefreshHandler(store) { RenewalSupported = true };
        using var client = new HttpClient(handler);
        var session = new CloudTokenSession(client, store);
        await Assert.ThrowsExactlyAsync<IOException>(() => session.GetAccessAsync(CancellationToken.None));
        Assert.IsFalse(store.Saved!.RefreshPending);
        store.FailWrite = null;
        await session.GetAccessAsync(CancellationToken.None);
        Assert.AreEqual(1, handler.Renewals);
        Assert.AreEqual(0, handler.Requests);
    }

    [TestMethod]
    [DataRow("unauthorized")]
    [DataRow("forbidden")]
    public async Task RejectedLongLivedAuthorizationRequiresPairingAndNeverFallsBack(string failure)
    {
        var store = new MemoryStore();
        using var handler = new RefreshHandler(store) { RenewalSupported = true, Failure = failure };
        using var client = new HttpClient(handler);
        var session = new CloudTokenSession(client, store);
        await Assert.ThrowsExactlyAsync<CloudReconnectRequiredException>(() => session.GetAccessAsync(CancellationToken.None));
        Assert.IsTrue(store.Saved!.ReconnectRequired);
        await Assert.ThrowsExactlyAsync<CloudReconnectRequiredException>(() => new CloudTokenSession(client, store).GetAccessAsync(CancellationToken.None));
        Assert.AreEqual(1, handler.Renewals);
        Assert.AreEqual(0, handler.Requests);
    }

    [TestMethod]
    public async Task DnsFailureBeforeSendingRefreshCanRetryWithoutReEnrollment()
    {
        var store = new MemoryStore();
        using var handler = new RefreshHandler(store) { Failure = "dns" };
        using var client = new HttpClient(handler);
        var session = new CloudTokenSession(client, store);
        await Assert.ThrowsExactlyAsync<HttpRequestException>(() => session.GetAccessAsync(CancellationToken.None));
        Assert.IsFalse(store.Saved!.RefreshPending);
        Assert.IsNull(await session.GetCachedAccessAsync(CancellationToken.None));
        handler.Failure = null;
        var granted = await session.GetAccessAsync(CancellationToken.None);
        Assert.AreEqual(2, handler.Requests);
        Assert.AreEqual(granted, await session.GetCachedAccessAsync(CancellationToken.None));
    }

    [TestMethod]
    public async Task AlreadyCancelledRefreshDoesNotLeaveAnIntentOrSendARequest()
    {
        var store = new MemoryStore();
        using var handler = new RefreshHandler(store);
        using var client = new HttpClient(handler);
        var session = new CloudTokenSession(client, store);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => session.GetAccessAsync(cancelled.Token));
        Assert.IsFalse(store.Saved!.RefreshPending);
        Assert.AreEqual(0, handler.Requests);
    }

    [TestMethod]
    [DataRow(404)]
    [DataRow(405)]
    public async Task ConcurrentRequestsRotateOnceAndUseTheNewIdentity(int missingEndpointStatus)
    {
        var store = new MemoryStore();
        using var handler = new RefreshHandler(store) { MissingEndpointStatus = (HttpStatusCode)missingEndpointStatus };
        using var client = new HttpClient(handler);
        var session = new CloudTokenSession(client, store);
        var grants = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => session.GetAccessAsync(CancellationToken.None)));
        Assert.AreEqual(1, handler.Requests);
        Assert.IsTrue(grants.All(result => result.Credentials == store.Saved && result.Token == new string('a', 43)));
        Assert.IsFalse(store.Saved!.RefreshPending);
        Assert.AreEqual(new string('n', 43), store.Saved.RefreshToken);
    }

    [TestMethod]
    [DataRow("lost")]
    [DataRow("wrong_device")]
    [DataRow("expired")]
    [DataRow("not_rotated")]
    public async Task AmbiguousRefreshNeverResendsTheConsumedTokenEvenAfterRestart(string failure)
    {
        var store = new MemoryStore();
        using var handler = new RefreshHandler(store) { Failure = failure };
        using var client = new HttpClient(handler);
        var session = new CloudTokenSession(client, store);
        if (failure == "lost")
            await Assert.ThrowsExactlyAsync<HttpRequestException>(() => session.GetAccessAsync(CancellationToken.None));
        else
            await Assert.ThrowsExactlyAsync<InvalidDataException>(() => session.GetAccessAsync(CancellationToken.None));
        Assert.IsTrue(store.Saved!.RefreshPending);
        await Assert.ThrowsExactlyAsync<CloudReconnectRequiredException>(() => session.GetAccessAsync(CancellationToken.None));
        var restarted = new CloudTokenSession(client, store);
        await Assert.ThrowsExactlyAsync<CloudReconnectRequiredException>(() => restarted.GetAccessAsync(CancellationToken.None));
        Assert.AreEqual(1, handler.Requests);
    }

    [TestMethod]
    public async Task FailedFinalWriteRetriesLocallyWithoutAnotherRefresh()
    {
        var store = new MemoryStore { FailWrite = saved => !saved.RefreshPending };
        using var handler = new RefreshHandler(store);
        using var client = new HttpClient(handler);
        var session = new CloudTokenSession(client, store);
        await Assert.ThrowsExactlyAsync<IOException>(() => session.GetAccessAsync(CancellationToken.None));
        Assert.IsTrue(store.Saved!.RefreshPending);
        store.FailWrite = null;
        var grant = await session.GetAccessAsync(CancellationToken.None);
        Assert.AreEqual(new string('n', 43), grant.Credentials.RefreshToken);
        Assert.IsFalse(store.Saved!.RefreshPending);
        Assert.AreEqual(1, handler.Requests);
    }

    [TestMethod]
    public async Task FailedIntentWritePreventsAnyNetworkExchange()
    {
        var store = new MemoryStore { FailWrite = saved => saved.RefreshPending };
        using var handler = new RefreshHandler(store);
        using var client = new HttpClient(handler);
        var session = new CloudTokenSession(client, store);
        await Assert.ThrowsExactlyAsync<IOException>(() => session.GetAccessAsync(CancellationToken.None));
        Assert.AreEqual(0, handler.Requests);
        Assert.IsFalse(store.Saved!.RefreshPending);
        store.FailWrite = null;
        await session.GetAccessAsync(CancellationToken.None);
        Assert.AreEqual(1, handler.Requests);
    }

    [TestMethod]
    public async Task ReEnrollmentReplacesPendingTokensAndOldFailuresCannotDisableNewIdentity()
    {
        var store = new MemoryStore { FailWrite = saved => !saved.RefreshPending };
        var oldIdentity = store.Saved!;
        using var handler = new RefreshHandler(store);
        using var client = new HttpClient(handler);
        var session = new CloudTokenSession(client, store);
        await Assert.ThrowsExactlyAsync<IOException>(() => session.GetAccessAsync(CancellationToken.None));
        store.FailWrite = null;
        var newId = Guid.NewGuid().ToString();
        using var approved = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            device_id = newId, access_token = new string('b', 43), refresh_token = new string('c', 43),
            access_expires_at = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 900,
            // Server response fields must not become persistent local state.
            RefreshPending = true, CloudUrl = "https://wrong.example.test"
        }));
        await session.SaveEnrollmentAsync("https://new.example.test", approved.RootElement, CancellationToken.None);
        await session.InvalidateAccessAsync(new CloudAccess(oldIdentity, new string('a', 43)), CancellationToken.None);
        var current = await session.GetAccessAsync(CancellationToken.None);
        Assert.AreEqual("https://new.example.test", current.Credentials.CloudUrl);
        Assert.AreEqual(newId, current.Credentials.DeviceId);
        Assert.AreEqual(new string('b', 43), current.Token);
        Assert.IsFalse(current.Credentials.RefreshPending);
        Assert.AreEqual(1, handler.Requests);
        var removed = await session.ClearAsync(CancellationToken.None);
        Assert.AreEqual(current.Token, removed.AccessToken);
        Assert.IsNull(store.Load());
        await Assert.ThrowsExactlyAsync<InvalidDataException>(() => session.GetAccessAsync(CancellationToken.None));
    }

    [TestMethod]
    public void MachineEncryptedCredentialsAcceptOldFilesAndPersistTheRefreshMarker()
    {
        var folder = Path.Combine(Path.GetTempPath(), "LanPowerCredentialsTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            var identity = new CloudCredentials("https://cloud.example.test", Guid.NewGuid().ToString(), new string('r', 43));
            var legacy = JsonSerializer.SerializeToUtf8Bytes(new { identity.CloudUrl, identity.DeviceId, identity.RefreshToken });
            var path = Path.Combine(folder, "credentials.dat");
            File.WriteAllBytes(path, ProtectedData.Protect(legacy, null, DataProtectionScope.LocalMachine));
            var store = new CloudCredentialStore(folder);
            Assert.AreEqual(identity, store.Load());
            store.Save(identity with { RefreshPending = true });
            Assert.IsTrue(new CloudCredentialStore(folder).Load()!.RefreshPending);
            Assert.DoesNotContain(identity.RefreshToken, Encoding.UTF8.GetString(File.ReadAllBytes(path)));
            File.WriteAllText(path + ".new", "unfinished encrypted write");
            store.Delete();
            Assert.IsNull(store.Load());
            Assert.IsFalse(File.Exists(path + ".new"));
        }
        finally { Directory.Delete(folder, true); }
    }

    private sealed class MemoryStore : ICloudCredentialStore
    {
        public CloudCredentials? Saved = new("https://cloud.example.test", Guid.NewGuid().ToString(), new string('r', 43));
        public Func<CloudCredentials, bool>? FailWrite;
        public CloudCredentials? Load() => Saved;
        public void Save(CloudCredentials saved)
        {
            if (FailWrite?.Invoke(saved) == true) throw new IOException("test write failure");
            Saved = saved;
        }
        public void Delete() => Saved = null;
    }

    private sealed class RefreshHandler(MemoryStore store) : HttpMessageHandler
    {
        public int Requests;
        public int Renewals;
        public bool RenewalSupported;
        public HttpStatusCode MissingEndpointStatus = HttpStatusCode.NotFound;
        public string? Failure;
        public string AccessToken = new('a', 43);
        public Func<DateTimeOffset> UtcNow = () => DateTimeOffset.UtcNow;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var renewal = request.RequestUri!.AbsolutePath == "/api/v2/windows/renew";
            if (renewal)
            {
                Interlocked.Increment(ref Renewals);
                if (!RenewalSupported) return new HttpResponseMessage(MissingEndpointStatus);
            }
            else
            {
                Interlocked.Increment(ref Requests);
                Assert.IsTrue(store.Saved!.RefreshPending);
                Assert.AreEqual("https://cloud.example.test/api/v2/windows/token", request.RequestUri!.AbsoluteUri);
            }
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Assert.AreEqual(new string('r', 43), body.RootElement.GetProperty("refresh_token").GetString());
            await Task.Delay(20, token);
            if (Failure == "dns") throw new HttpRequestException(HttpRequestError.NameResolutionError, "test DNS failure");
            if (Failure == "lost") throw new HttpRequestException("test lost response");
            if (Failure == "timeout") throw new TaskCanceledException("test timeout");
            if (Failure == "pause") await Task.Delay(Timeout.Infinite, token);
            if (Failure == "server") return new HttpResponseMessage(HttpStatusCode.BadGateway);
            if (Failure == "unauthorized") return new HttpResponseMessage(HttpStatusCode.Unauthorized);
            if (Failure == "forbidden") return new HttpResponseMessage(HttpStatusCode.Forbidden);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(JsonSerializer.Serialize(new
                {
                    device_id = Failure == "wrong_device" ? Guid.NewGuid().ToString() : store.Saved!.DeviceId,
                    access_token = AccessToken,
                    refresh_token = new string(renewal ? (Failure == "rotated" ? 'n' : 'r') : (Failure == "not_rotated" ? 'r' : 'n'), 43),
                    access_expires_at = UtcNow().ToUnixTimeSeconds() + (Failure == "expired" ? -1 : 900)
                }), Encoding.UTF8, "application/json")
            };
        }
    }

    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }
}
