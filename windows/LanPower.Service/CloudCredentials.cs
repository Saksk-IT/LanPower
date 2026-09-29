using System.Security.Cryptography;
using System.Text.Json;

namespace LanPower.Service;

public sealed record CloudCredentials(string CloudUrl, string DeviceId, string RefreshToken);

public sealed class CloudCredentialStore
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
            return JsonSerializer.Deserialize<CloudCredentials>(plain) ?? throw new InvalidDataException("Cloud 凭据无效");
        }
    }

    public void Save(CloudCredentials credentials)
    {
        var plain = JsonSerializer.SerializeToUtf8Bytes(credentials);
        var protectedBytes = ProtectedData.Protect(plain, null, DataProtectionScope.LocalMachine);
        CryptographicOperations.ZeroMemory(plain);
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
}
