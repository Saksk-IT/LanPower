using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using LanPower.Shared;

namespace LanPower.Desktop;

internal static class PipeClient
{
    public static async Task<JsonDocument> RequestAsync(string command)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
        await using var pipe = new NamedPipeClientStream(".", LanProtocol.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(timeout.Token);
        using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
        await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
        await writer.WriteLineAsync(command);
        var response = await reader.ReadLineAsync(timeout.Token) ?? throw new IOException("服务没有响应");
        return JsonDocument.Parse(response);
    }
}
