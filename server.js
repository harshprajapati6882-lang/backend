const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

/* =========================
   HELPER: PLACE ORDER
========================= */
async function placeOrder({ apiUrl, apiKey, service, link, quantity }) {
  const params = new URLSearchParams({
    key: apiKey,
    action: 'add',
    service: String(service),
    link: String(link),
    quantity: String(quantity),
  });

  const response = await axios.post(apiUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return response.data;
}

/* =========================
   PROCESS RUNS (WITH DELAY)
========================= */
async function processRunsSequentially(runs, config) {
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];

    console.log(`Executing run ${i + 1}`, run);

    try {
      const result = await placeOrder({
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
        service: config.service,
        link: config.link,
        quantity: run.quantity,
      });

      // ✅ PROPER RESPONSE HANDLING
      if (result?.order) {
        console.log(`Run ${i + 1} SUCCESS:`, result.order);

      } else if (result?.error) {
        console.error(`Run ${i + 1} FAILED:`, result.error);

      } else if (result?.status === 'fail') {
        console.error(`Run ${i + 1} FAILED:`, result.message);

      } else {
        console.error(`Run ${i + 1} UNKNOWN RESPONSE:`, result);
      }

    } catch (err) {
      console.error(`Run ${i + 1} ERROR:`, err.response?.data || err.message);
    }

    // 🔥 IMPORTANT: wait before next run (prevents panel blocking)
    console.log(`Waiting 60 seconds before next run...`);
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

/* =========================
   CREATE ORDER (SCHEDULER)
========================= */
app.post('/api/order', async (req, res) => {
  const { apiUrl, apiKey, service, link, runs } = req.body;

  if (!apiUrl || !apiKey || !service || !link || !runs?.length) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  console.log('Received runs:', runs);

  // Run in background (non-blocking)
  processRunsSequentially(runs, {
    apiUrl,
    apiKey,
    service,
    link,
  });

  return res.json({
    success: true,
    message: 'Order scheduled successfully',
  });
});

/* =========================
   FETCH SERVICES
========================= */
app.post('/api/services', async (req, res) => {
  const { apiUrl, apiKey } = req.body;

  if (!apiUrl || !apiKey) {
    return res.status(400).json({ error: 'Missing API URL or key' });
  }

  try {
    const params = new URLSearchParams({
      key: apiKey,
      action: 'services',
    });

    const response = await axios.post(apiUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    return res.json(response.data);
  } catch (error) {
    return res.status(500).json({
      error: error.response?.data || error.message,
    });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
