import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.post('/api/order', async (req, res) => {
  const { apiUrl, apiKey, service, link, quantity } = req.body;

  // Allow API key from request body or environment variable.
  const resolvedApiKey = apiKey || process.env.SMM_API_KEY;

  console.log('[POST /api/order] Incoming payload:', {
    apiUrl,
    service,
    link,
    quantity,
    hasApiKey: Boolean(resolvedApiKey),
  });

  if (!apiUrl || !resolvedApiKey || !service || !link || !quantity) {
    console.error('[POST /api/order] Missing required fields.');
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

    console.log('[POST /api/order] Sending request to panel:', apiUrl);

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
    const panelError = error.response?.data?.error || error.response?.data;
    const errorMessage =
      (typeof panelError === 'string' && panelError) ||
      error.message ||
      'Failed to create order.';

    console.error('[POST /api/order] Request failed:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });

    return res.status(500).json({ error: errorMessage });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});