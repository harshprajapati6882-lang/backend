const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

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

app.post('/api/order', async (req, res) => {
  const { apiUrl, apiKey, service, link, runs } = req.body;

  if (!apiUrl || !apiKey || !service || !link || !runs?.length) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  console.log('Received runs:', runs);

  runs.forEach((run, index) => {
    const runTime = new Date(run.time).getTime();
    const now = Date.now();

    // FIXED DELAY LOGIC
    const delay = Math.max(runTime - now, 0);

    // TEMP: force execution within 10 seconds (for testing)
    const finalDelay = Math.min(delay, 10000);

    console.log(`Run ${index + 1} will execute in ${finalDelay} ms`);

    setTimeout(async () => {
      try {
        console.log(`Executing run ${index + 1}`, run);

        const result = await placeOrder({
          apiUrl,
          apiKey,
          service,
          link,
          quantity: run.quantity,
        });

        if (result?.order) {
          console.log(`Run ${index + 1} SUCCESS:`, result.order);
        } else if (result?.error) {
          console.error(`Run ${index + 1} FAILED:`, result.error);
        } else {
          console.error(`Run ${index + 1} UNKNOWN:`, result);
        }

      } catch (err) {
        console.error(`Run ${index + 1} ERROR:`, err.response?.data || err.message);
      }
    }, finalDelay);
  });

  return res.json({
    success: true,
    message: 'Order scheduled',
  });
});

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
