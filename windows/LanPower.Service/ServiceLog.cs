namespace LanPower.Service;

public sealed class ServiceLog
{
    private readonly string _path;
    private readonly object _sync = new();

    public ServiceLog(string path)
    {
        _path = path;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    }

    public void Write(string message)
    {
        lock (_sync)
        {
            if (File.Exists(_path) && new FileInfo(_path).Length > 1_000_000)
                File.Move(_path, _path + ".1", true);
            File.AppendAllText(_path, $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
        }
    }

    public string ReadTail()
    {
        lock (_sync)
        {
            if (!File.Exists(_path)) return "暂无日志";
            return string.Join(Environment.NewLine, File.ReadLines(_path).TakeLast(80));
        }
    }

    public void WriteFailure(string operation, Exception error)
    {
        var causes = new List<string>();
        for (Exception? cause = error; cause is not null && causes.Count < 6; cause = cause.InnerException)
        {
            var detail = cause.GetType().Name + $"[0x{cause.HResult:X8}]";
            if (cause is HttpRequestException http)
                detail += ":" + http.HttpRequestError + (http.StatusCode is { } status ? $" HTTP {(int)status}" : "");
            if (cause is System.ComponentModel.Win32Exception native)
                detail += $":Win32 {native.NativeErrorCode}";
            causes.Add(detail);
        }
        // Exception messages and response bodies may contain URLs or credentials.
        Write(operation + "：" + string.Join(" -> ", causes));
    }
}
