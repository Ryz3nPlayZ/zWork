import unittest
import os
import tempfile
from fastapi.testclient import TestClient
from sidecar import server
from sidecar.agent import chatstore

class TestNewFeatures(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.mkdtemp()
        self._old_home = os.environ.get("ZWORK_HOME")
        os.environ["ZWORK_HOME"] = self._tmp
        self.client = TestClient(server.app)

    def tearDown(self) -> None:
        if self._old_home is None:
            os.environ.pop("ZWORK_HOME", None)
        else:
            os.environ["ZWORK_HOME"] = self._old_home

    def test_truncate_message(self) -> None:
        # 1. Create a chat
        c = chatstore.create(title="Test Truncate Chat")
        
        # 2. Append multiple messages
        msg1 = chatstore.append_message(c.id, "user", "Message 1")
        msg2 = chatstore.append_message(c.id, "assistant", "Message 2")
        msg3 = chatstore.append_message(c.id, "user", "Message 3")
        
        # Verify initial count
        c_loaded = chatstore.get(c.id)
        self.assertEqual(len(c_loaded.messages), 3)
        
        # 3. Call the truncate endpoint targeting msg2
        payload = {
            "content": "Message 2 edited"
        }
        url = f"/api/chats/{c.id}/messages/{msg2.id}/truncate"
        response = self.client.post(url, json=payload)
        
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data.get("ok"))
        
        # Verify the message truncation on disk/store
        c_after = chatstore.get(c.id)
        self.assertEqual(len(c_after.messages), 2)
        self.assertEqual(c_after.messages[0].id, msg1.id)
        self.assertEqual(c_after.messages[1].id, msg2.id)
        self.assertEqual(c_after.messages[1].content, "Message 2 edited")

    def test_run_python_code(self) -> None:
        # Test success run
        payload = {
            "code": "print('Hello from Sandbox!')"
        }
        response = self.client.post("/api/run-python", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data.get("stdout"), "Hello from Sandbox!\n")
        self.assertEqual(data.get("stderr"), "")

        # Test error run
        payload_err = {
            "code": "import sys; print('An error message', file=sys.stderr)"
        }
        response_err = self.client.post("/api/run-python", json=payload_err)
        self.assertEqual(response_err.status_code, 200)
        data_err = response_err.json()
        self.assertEqual(data_err.get("stdout"), "")
        self.assertEqual(data_err.get("stderr"), "An error message\n")

        # Test timeout run
        payload_timeout = {
            "code": "import time\ntime.sleep(12)"
        }
        response_timeout = self.client.post("/api/run-python", json=payload_timeout)
        self.assertEqual(response_timeout.status_code, 200)
        data_timeout = response_timeout.json()
        self.assertEqual(data_timeout.get("stdout"), "")
        self.assertEqual(data_timeout.get("stderr"), "Execution timeout (10s)")

if __name__ == "__main__":
    unittest.main()
