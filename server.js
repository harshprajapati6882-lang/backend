import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

/* =========================
   CREATE ORDER
========================= */
app.post('/api/order', async (req, res) => {
  const { apiUrl, apiKey, service, link, quantity } = req.body;

  const resolvedApiKey = apiKey || process.env.SMM_API_KEY;

  console.log('[POST /api/order] Incoming payload:', {
    apiUrl,
    service,
    link,
    quantity,
    hasApiKey: Boolean(resolvedApiKey),
  });

  if (!apiUrl || !resolvedApiKey || !service || !link || !quantity) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    const params = new URLSearchParams({
      key: resolvedApiKey,
      action: 'add',
      service: String(service),
      link: String(link),
      quantity: String(quantity),
    });

    const panelResponse = await axios.post(apiUrl, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 15000,
    });

    console.log('[POST /api/order] Panel response:', panelResponse.data);

    if (panelResponse.data?.order) {
      return res.json({ order: panelResponse.data.order });
    }

    if (panelResponse.data?.error) {
      return res.status(400).json({ error: panelResponse.data.error });
    }

    return res.status(400).json({ error: 'Unexpected response from SMM panel.' });
  } catch (error) {
    console.error('[POST /api/order] Error:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });

    return res.status(500).json({
      error:
        error.response?.data?.error ||
        error.message ||
        'Failed to create order.',
    });
  }
});

/* =========================
   FETCH SERVICES (FIXED)
========================= */
app.post('/api/services', async (req, res) => {
  const { apiUrl, apiKey } = req.body;

  const resolvedApiKey = apiKey || process.env.SMM_API_KEY;

  console.log('[POST /api/services] Incoming:', {
    apiUrl,
    hasApiKey: Boolean(resolvedApiKey),
  });

  if (!apiUrl || !resolvedApiKey) {
    return res.status(400).json({ error: 'Missing API URL or API key' });
  }

  try {
    const params = new URLSearchParams({
      key: resolvedApiKey,
      action: 'services',
    });

    const response = await axios.post(apiUrl, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 15000,
    });

    console.log('[POST /api/services] Panel response:', response.data);

    return res.json(response.data);
  } catch (error) {
    console.error('[POST /api/services] Error:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });

    return res.status(500).json({
      error:
        error.response?.data?.error ||
        error.message ||
        'Failed to fetch services',
    });
  }
});

/* =========================
   SERVER START
========================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
