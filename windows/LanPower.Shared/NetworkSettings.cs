namespace LanPower.Shared;

public sealed record LanAdapter(string Id, string Name, string Address, int PrefixLength, bool Wireless, bool Connected);
public sealed record NetworkSettings(string AdapterId, bool Automatic, string Address, string Subnet, int Port, LanAdapter[] Adapters);
