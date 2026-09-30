from cloud_app.tests.test_gateway_v2 import cloud, enroll


def test_device_management_stays_with_its_device_type(cloud):
    client, _, csrf = cloud
    for kind, page, other_page in [("windows", "/devices", "/gateways"), ("gateway", "/gateways", "/devices")]:
        device_id, _ = enroll(client, kind)
        name = "Managed " + kind
        response = client.post(f"/devices/{device_id}/rename", data={"csrf": csrf, "name": name},
                               follow_redirects=False)
        assert response.status_code == 303 and response.headers["location"] == page
        assert f'data-status-id="{device_id}"' in client.get(page).text
        assert f'data-status-id="{device_id}"' not in client.get(other_page).text
        response = client.post(f"/devices/{device_id}/revoke", data={"csrf": csrf}, follow_redirects=False)
        assert response.status_code == 303 and response.headers["location"] == page
        assert f'data-status-id="{device_id}"' not in client.get(page).text


def test_enrollment_keeps_short_code_and_legacy_entry_usable(cloud):
    client, _, csrf = cloud
    response = client.get("/devices/enroll", follow_redirects=False)
    assert response.status_code == 303 and response.headers["location"] == "/enroll"
    assert 'action="/enroll/lookup"' in client.get(response.headers["location"]).text
    legacy = client.post("/devices/enroll", data={"csrf": csrf})
    assert legacy.status_code == 200 and 'id="legacy-code"' in legacy.text
    # The old URL still requires authentication before redirecting into settings.
    client.post("/logout", data={"csrf": csrf})
    assert client.get("/system", follow_redirects=False).headers["location"] == "/login"
