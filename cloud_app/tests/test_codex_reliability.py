import pytest

from cloud_app.app.remote import ProtocolError, validate_request


def call(method, **params):
    return {"id": "rpc", "method": method, "params": {"threadId": "thread", **params}}


def test_receipt_and_large_history_queries_require_identity_and_bounds():
    assert validate_request(call("lanpower/submission/read", submissionId="submission")) == "lanpower/submission/read"
    assert validate_request(call("lanpower/history/item/read", reference="reference", offset=65536)) == "lanpower/history/item/read"
    for request in [call("lanpower/submission/read"), call("lanpower/history/item/read", reference="reference", offset=-1),
                    call("lanpower/history/item/read", reference="reference", offset=True),
                    call("lanpower/history/item/read", reference="reference", offset=64 * 1024 * 1024 + 1),
                    call("thread/read", historyLimit=9)]:
        with pytest.raises(ProtocolError):
            validate_request(request)


def test_submission_id_does_not_enable_permission_overrides():
    valid = call("turn/start", submissionId="submission", input=[{"type": "text", "text": "safe"}])
    assert validate_request(valid) == "turn/start"
    for override in [{"sandbox": "danger-full-access"}, {"approvalPolicy": "never"}, {"submissionId": "x" * 101}]:
        with pytest.raises(ProtocolError):
            validate_request({**valid, "params": {**valid["params"], **override}})
