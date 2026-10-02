using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using LanPower.Shared;

namespace LanPower.UnitTests;

[TestClass]
public sealed class ReleaseTests
{
    [TestMethod]
    [DataRow("v1.11.0", true)]
    [DataRow("v1.4.0", false)]
    [DataRow("v1.1.2", false)]
    public async Task UpdateCheckUsesStableVersionsAndSendsNoPrivateCredentials(string tag, bool update)
    {
        using var handler = new ReleaseHandler(tag);
        using var client = new HttpClient(handler);
        var release = await ReleaseChecker.CheckAsync(client, "1.4.0", CancellationToken.None);
        Assert.IsNotNull(release);
        Assert.AreEqual(update, release.UpdateAvailable);
        Assert.AreEqual("https://github.com/Saksk-IT/LanPower/releases/tag/" + tag, release.PageUrl);
    }

    [TestMethod]
    [DataRow("url")]
    [DataRow("preview")]
    [DataRow("draft")]
    public async Task InvalidReleaseDoesNotProduceADownloadLink(string failure)
    {
        using var handler = new ReleaseHandler("v1.5.0") { Failure = failure };
        using var client = new HttpClient(handler);
        await Assert.ThrowsExactlyAsync<InvalidDataException>(() => ReleaseChecker.CheckAsync(client, "1.4.0", CancellationToken.None));
    }

    [TestMethod]
    public async Task EmptyReleaseListIsReportedWithoutAnInventedVersion()
    {
        using var handler = new ReleaseHandler("v1.5.0") { Status = HttpStatusCode.NotFound };
        using var client = new HttpClient(handler);
        Assert.IsNull(await ReleaseChecker.CheckAsync(client, "1.4.0", CancellationToken.None));
    }

    private sealed class ReleaseHandler(string tag) : HttpMessageHandler
    {
        public string? Failure;
        public HttpStatusCode Status = HttpStatusCode.OK;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Assert.AreEqual(ReleaseChecker.ApiUrl, request.RequestUri!.AbsoluteUri);
            Assert.IsNull(request.Headers.Authorization);
            Assert.IsFalse(request.Headers.Contains("Cookie"));
            Assert.IsNull(request.Content);
            return Task.FromResult(new HttpResponseMessage(Status)
            {
                Content = new StringContent(JsonSerializer.Serialize(new
                {
                    tag_name = Failure == "preview" ? tag + "-preview" : tag,
                    html_url = Failure == "url" ? "https://other.example.test/download" : "https://github.com/Saksk-IT/LanPower/releases/tag/" + tag,
                    draft = Failure == "draft", prerelease = false
                }), Encoding.UTF8, "application/json")
            });
        }
    }
}
