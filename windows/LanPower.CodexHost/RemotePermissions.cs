using System.Text.Json.Nodes;

namespace LanPower.CodexHost;

public static class RemotePermissions
{
    public static JsonObject Parameters(string threadId, string cwd, string mode)
    {
        if (mode is not ("ask" or "auto-review" or "full-access")) throw new InvalidDataException("invalid_params");
        return new() {
            ["threadId"] = threadId,
            ["approvalPolicy"] = mode == "full-access" ? "never" : "on-request",
            ["approvalsReviewer"] = mode == "auto-review" ? "auto_review" : "user",
            ["sandboxPolicy"] = mode == "full-access" ? new JsonObject { ["type"] = "dangerFullAccess" }
                : new JsonObject { ["type"] = "workspaceWrite", ["networkAccess"] = false,
                    ["excludeTmpdirEnvVar"] = true, ["excludeSlashTmp"] = true, ["writableRoots"] = new JsonArray(cwd) }
        };
    }
}
