using LanPower.CodexHost;
try { await SharedCodexServer.RunAsync(CancellationToken.None); }
catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidOperationException or System.ComponentModel.Win32Exception) { }
