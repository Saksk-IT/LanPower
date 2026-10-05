using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using LanPower.Service;

namespace LanPower.UnitTests;

[TestClass]
public sealed class EnrollmentTests
{
    [TestMethod]
    public void LocalHttpOriginsAreAcceptedWhilePublicHttpIsRejected()
    {
        foreach (var address in new[] { "http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080",
            "http://10.1.2.3:8080", "http://172.16.1.2:8080", "http://192.168.1.2:8080" })
            Assert.AreEqual(address, CloudEnrollment.NormalizeOrigin(address));
        foreach (var address in new[] { "http://8.8.8.8", "http://172.32.1.2", "http://169.254.1.2",
            "http://localhost.evil.test", "http://localhost@evil.test", "http://[fc00::1]", "http://localhost/path" })
            Assert.ThrowsExactly<ArgumentException>(() => CloudEnrollment.NormalizeOrigin(address));
    }

    [TestMethod]
    public async Task DeviceCodeStaysInServiceAndApprovedTokensAreSavedOnce()
    {
        var clock = new EnrollmentClock();
        using var handler = new EnrollmentHandler();
        using var http = new HttpClient(handler);
        var saves = 0;
        var enrollment = new CloudEnrollment(http, (origin, data, _) =>
        {
            Assert.AreEqual("https://cloud.example.test", origin);
            Assert.AreEqual(handler.DeviceId, data.GetProperty("device_id").GetString());
            saves++;
            return Task.CompletedTask;
        }, clock);
        var pairing = await enrollment.BeginAsync("https://cloud.example.test", CancellationToken.None);
        Assert.AreEqual("A7K2-M9QP", pairing.UserCode);
        Assert.DoesNotContain(handler.DeviceCode, JsonSerializer.Serialize(pairing));
        Assert.AreEqual("pending", await enrollment.PollAsync(pairing.Id, CancellationToken.None));
        Assert.AreEqual("pending", await enrollment.PollAsync(pairing.Id, CancellationToken.None));
        Assert.AreEqual(1, handler.Polls);
        handler.Approved = true;
        clock.Now += TimeSpan.FromSeconds(5);
        Assert.AreEqual("connected", await enrollment.PollAsync(pairing.Id, CancellationToken.None));
        Assert.AreEqual("connected", await enrollment.PollAsync(pairing.Id, CancellationToken.None));
        Assert.AreEqual(1, saves);
        Assert.AreEqual(2, handler.Polls);
    }

    [TestMethod]
    public async Task LocalWriteFailureRetriesWithoutSecondTokenExchange()
    {
        using var handler = new EnrollmentHandler { Approved = true };
        using var http = new HttpClient(handler);
        var saves = 0;
        var enrollment = new CloudEnrollment(http, (_, _, _) =>
        {
            if (++saves == 1) throw new IOException("temporary write failure");
            return Task.CompletedTask;
        });
        var pairing = await enrollment.BeginAsync("https://cloud.example.test", CancellationToken.None);
        await Assert.ThrowsExactlyAsync<IOException>(() => enrollment.PollAsync(pairing.Id, CancellationToken.None));
        Assert.AreEqual("connected", await enrollment.PollAsync(pairing.Id, CancellationToken.None));
        Assert.AreEqual(1, handler.Polls);
        Assert.AreEqual(2, saves);
    }

    [TestMethod]
    public async Task DeniedExpiredAndReplacedRequestsCannotSaveCredentials()
    {
        using var handler = new EnrollmentHandler { Denied = true };
        using var http = new HttpClient(handler);
        var clock = new EnrollmentClock();
        var enrollment = new CloudEnrollment(http, (_, _, _) => throw new AssertFailedException("unexpected save"), clock);
        var first = await enrollment.BeginAsync("https://cloud.example.test", CancellationToken.None);
        Assert.AreEqual("denied", await enrollment.PollAsync(first.Id, CancellationToken.None));
        var second = await enrollment.BeginAsync("https://cloud.example.test", CancellationToken.None);
        Assert.AreEqual("expired", await enrollment.PollAsync(first.Id, CancellationToken.None));
        clock.Now += TimeSpan.FromSeconds(601);
        Assert.AreEqual("expired", await enrollment.PollAsync(second.Id, CancellationToken.None));
        Assert.AreEqual(1, handler.Polls);
    }

    [TestMethod]
    public async Task RedirectedApprovalPageIsRejected()
    {
        using var handler = new EnrollmentHandler { VerificationUri = "https://other.example.test/enroll" };
        using var http = new HttpClient(handler);
        var enrollment = new CloudEnrollment(http, (_, _, _) => Task.CompletedTask);
        await Assert.ThrowsExactlyAsync<InvalidDataException>(() => enrollment.BeginAsync("https://cloud.example.test", CancellationToken.None));
        foreach (var address in new[] { "http://cloud.example.test", "https://user@cloud.example.test", "https://cloud.example.test/path" })
            await Assert.ThrowsExactlyAsync<ArgumentException>(() => enrollment.BeginAsync(address, CancellationToken.None));
    }

    [TestMethod]
    public async Task CancelledEnrollmentCannotRedeemLaterApproval()
    {
        using var handler = new EnrollmentHandler { Approved = true };
        using var http = new HttpClient(handler);
        var enrollment = new CloudEnrollment(http, (_, _, _) => throw new AssertFailedException("unexpected save"));
        var pairing = await enrollment.BeginAsync("https://cloud.example.test", CancellationToken.None);
        await enrollment.CancelAsync(pairing.Id, CancellationToken.None);
        Assert.AreEqual("expired", await enrollment.PollAsync(pairing.Id, CancellationToken.None));
        Assert.AreEqual(0, handler.Polls);
    }

    private sealed class EnrollmentClock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class EnrollmentHandler : HttpMessageHandler
    {
        public string DeviceId { get; } = Guid.NewGuid().ToString();
        public string DeviceCode { get; } = new('s', 43);
        public string VerificationUri { get; set; } = "https://cloud.example.test/enroll";
        public bool Approved { get; set; }
        public bool Denied { get; set; }
        public int Polls { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            object result;
            var status = HttpStatusCode.OK;
            if (request.RequestUri!.AbsolutePath == "/api/v2/enroll/start")
                result = new { device_code = DeviceCode, user_code = "A7K2-M9QP", verification_uri = VerificationUri, expires_in = 600, interval = 5 };
            else
            {
                Polls++;
                Assert.AreEqual("/api/v2/enroll/token", request.RequestUri.AbsolutePath);
                using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                Assert.AreEqual(DeviceCode, body.RootElement.GetProperty("device_code").GetString());
                if (Approved) result = new { device_id = DeviceId, access_token = new string('a', 43), refresh_token = new string('r', 43), access_expires_at = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 900 };
                else
                {
                    status = HttpStatusCode.BadRequest;
                    result = new { error = Denied ? "access_denied" : "authorization_pending" };
                }
            }
            return new HttpResponseMessage(status) { Content = new StringContent(JsonSerializer.Serialize(result), Encoding.UTF8, "application/json") };
        }
    }
}
