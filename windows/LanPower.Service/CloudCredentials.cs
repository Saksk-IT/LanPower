using System.Security.Cryptography;
using System.Text.Json;

namespace LanPower.Service;

public sealed record CloudCredentials(string CloudUrl, string DeviceId, string RefreshToken,
    bool RefreshPending = false, bool ReconnectRequired = false);

public interface ICloudCredentialStore
{
    CloudCredentials? Load();
    void Save(CloudCredentials credentials);
    void Delete();
}

public sealed class CloudCredentialStore : ICloudCredentialStore
{
    private readonly string _path;
    private readonly object _sync = new();

    public CloudCredentialStore(string dataDirectory)
    {
        Directory.CreateDirectory(dataDirectory);
        _path = Path.Combine(dataDirectory, "credentials.dat");
    }

    public CloudCredentials? Load()
    {
        lock (_sync)
        {
            if (!File.Exists(_path)) return null;
            var plain = ProtectedData.Unprotect(File.ReadAllBytes(_path), null, DataProtectionScope.LocalMachine);
            try
            {
                var saved = JsonSerializer.Deserialize<CloudCredentials>(plain) ?? throw new InvalidDataException("Cloud 凭据无效");
                CloudTokenSession.ValidateCredentials(saved);
                return saved;
            }
            finally { CryptographicOperations.ZeroMemory(plain); }
        }
    }

    public void Save(CloudCredentials credentials)
    {
        CloudTokenSession.ValidateCredentials(credentials);
        var plain = JsonSerializer.SerializeToUtf8Bytes(credentials);
        byte[] protectedBytes;
        try { protectedBytes = ProtectedData.Protect(plain, null, DataProtectionScope.LocalMachine); }
        finally { CryptographicOperations.ZeroMemory(plain); }
        lock (_sync)
        {
            var temporary = _path + ".new";
            using (var file = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                file.Write(protectedBytes);
                file.Flush(true);
            }
            File.Move(temporary, _path, true);
        }
    }

    public void Delete()
    {
        lock (_sync)
        {
            // Remove an unfinished encrypted write first. A failure leaves the
            // active credential in place and is reported to the desktop.
            File.Delete(_path + ".new");
            File.Delete(_path);
        }
    }
}
