using System.ComponentModel;
using System.Net;
using LanPower.Service;

namespace LanPower.UnitTests;

[TestClass]
public sealed class ServiceLogTests
{
    [TestMethod]
    public void ConnectionDiagnosticsExposeCodesWithoutExceptionSecrets()
    {
        var directory = Path.Combine(Path.GetTempPath(), "LanPower-log-" + Guid.NewGuid());
        try
        {
            var log = new ServiceLog(Path.Combine(directory, "service.log"));
            log.WriteFailure("Cloud connection", new HttpRequestException(HttpRequestError.SecureConnectionError,
                "https://private.example/?token=secret-token", new Win32Exception(12175, "Authorization: Bearer secret-token"),
                HttpStatusCode.BadGateway));
            var recorded = log.ReadTail();
            StringAssert.Contains(recorded, "SecureConnectionError");
            StringAssert.Contains(recorded, "HTTP 502");
            StringAssert.Contains(recorded, "Win32 12175");
            Assert.IsFalse(recorded.Contains("secret-token", StringComparison.Ordinal));
            Assert.IsFalse(recorded.Contains("private.example", StringComparison.Ordinal));
            Assert.IsFalse(recorded.Contains("Authorization", StringComparison.Ordinal));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
    }
}
