import pytest

from cloud_app.app.remote import ProtocolError, validate_request


def request(method, **params):
    return {"id": "queue-test", "method": method, "params": {"threadId": "chat", **params}}


def test_native_queue_identity_and_text_are_required():
    valid = request("thread/queue/add", clientUserMessageId="one", input=[{"type": "text", "text": "下一轮执行"}])
    assert validate_request(valid) == "thread/queue/add"
    for changes in [{"clientUserMessageId": ""}, {"input": []}, {"approvalPolicy": "never"},
                    {"input": [{"type": "image", "url": "file:///private"}]}]:
        bad = {**valid, "params": {**valid["params"], **changes}}
        with pytest.raises(ProtocolError):
            validate_request(bad)


@pytest.mark.parametrize("method,params", [
    ("thread/queue/list", {"limit": 32}),
    ("thread/queue/delete", {"queuedSubmissionId": "one"}),
    ("thread/queue/update", {"queuedSubmissionId": "one", "input": [{"type": "text", "text": "更改"}]}),
    ("thread/queue/reorder", {"queuedSubmissionIds": ["one", "two"]}),
    ("thread/queue/start", {"queuedSubmissionId": "one"}),
])
def test_queue_methods_keep_strict_parameter_allowlist(method, params):
    assert validate_request(request(method, **params)) == method
    with pytest.raises(ProtocolError):
        validate_request(request(method, **params, sandbox="danger-full-access"))


def test_queue_reorder_rejects_duplicate_and_oversized_ids():
    for ids in [["same", "same"], ["x" * 101], []]:
        with pytest.raises(ProtocolError):
            validate_request(request("thread/queue/reorder", queuedSubmissionIds=ids))
