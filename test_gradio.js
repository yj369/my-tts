fetch("http://127.0.0.1:7860/gradio_api/call/gen_single", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
        "data": [
            "Use emotion reference audio",
            {"path": "/tmp/dummy.wav", "meta": {"_type": "gradio.FileData"}},
            "Hello!!",
            {"path": "/tmp/dummy.wav", "meta": {"_type": "gradio.FileData"}},
            0.65,
            0, 0, 0, 0, 0, 0, 0, 0,
            "",
            false,
            120,
            true, 0.8, 30, 0.8, 0, 3, 10, 1500
        ]
    })
}).then(r => r.json()).then(r => {
    console.log("EVENT ID:", r.event_id);
    if (!r.event_id) return;
    return fetch("http://127.0.0.1:7860/gradio_api/call/gen_single/" + r.event_id);
}).then(r => r.text()).then(t => console.log(t));
