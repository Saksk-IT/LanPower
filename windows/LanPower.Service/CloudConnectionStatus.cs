namespace LanPower.Service;

public sealed class CloudConnectionStatus(TimeProvider? clock = null)
{
    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private long _lastSeen;
    private long _lastPoll;
    private int _hasPoll;

    public long LastSeen => Interlocked.Read(ref _lastSeen);
    public bool Connected => Volatile.Read(ref _hasPoll) != 0 &&
        _clock.GetElapsedTime(Interlocked.Read(ref _lastPoll)) <= TimeSpan.FromSeconds(90);

    public void RecordSuccess(bool poll = false)
    {
        Interlocked.Exchange(ref _lastSeen, _clock.GetUtcNow().ToUnixTimeSeconds());
        if (!poll) return;
        Interlocked.Exchange(ref _lastPoll, _clock.GetTimestamp());
        Volatile.Write(ref _hasPoll, 1);
    }

    public void Reset()
    {
        Volatile.Write(ref _hasPoll, 0);
        Interlocked.Exchange(ref _lastSeen, 0);
    }
}
