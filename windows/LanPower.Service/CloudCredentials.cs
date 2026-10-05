using System.Security.Cryptography;
using System.Text.Json;

namespace LanPower.Service;

public sealed record CloudCredentials(string CloudUrl, string DeviceId, string RefreshToken,
    bool RefreshPending = false, bool ReconnectRequired = false, string AccountUsername = "");

public interface ICloudCredentialStore
{
    CloudCredentials? Load();
    void Save(CloudCredentials credentials);
    void Delete();
}

public sealed class CloudCredentialStore : ICloudCredentialStore
{
    private readonly string _path;
    private readonly string _accountKeyPath;
    private readonly object _sync = new();

    public CloudCredentialStore(string dataDirectory)
    {
        Directory.CreateDirectory(dataDirectory);
        _path = Path.Combine(dataDirectory, "credentials.dat");
        _accountKeyPath = Path.Combine(dataDirectory, "account-key.dat");
    }

    public string AccountConnectionKey()
    {
        lock (_sync)
        {
            if (File.Exists(_accountKeyPath))
            {
                var plain = ProtectedData.Unprotect(File.ReadAllBytes(_accountKeyPath), null, DataProtectionScope.LocalMachine);
                try
                {
                    var key = System.Text.Encoding.UTF8.GetString(plain);
                    if (key.Length != 43 || key.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_')))
                        throw new InvalidDataException("账号连接凭据无效");
                    return key;
                }
                finally { CryptographicOperations.ZeroMemory(plain); }
            }
            var created = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            var bytes = System.Text.Encoding.UTF8.GetBytes(created);
            try
            {
                var encrypted = ProtectedData.Protect(bytes, null, DataProtectionScope.LocalMachine);
                using (var file = new FileStream(_accountKeyPath + ".new", FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    file.Write(encrypted);
                    file.Flush(true);
                }
                File.Move(_accountKeyPath + ".new", _accountKeyPath, true);
            }
            finally { CryptographicOperations.ZeroMemory(bytes); }
            return created;
        }
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
            File.Delete(_accountKeyPath + ".new");
            File.Delete(_accountKeyPath);
        }
    }
}
