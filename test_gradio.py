import subprocess
import requests

payload = {
    "data": [
        "Use emotion reference audio",
        {"path": "/absolute/path/dummy.wav", "meta": {"_type": "gradio.FileData"}},
        "Hello!!",
        {"path": "/absolute/path/dummy.wav", "meta": {"_type": "gradio.FileData"}},
        0.65,
        0, 0, 0, 0, 0, 0, 0, 0,
        "",
        False,
        120,
        True, 0.8, 30, 0.8, 0, 3, 10, 1500
    ]
}

res = requests.post("http://127.0.0.1:7860/gradio_api/call/gen_single", json=payload)
print(res.json())
