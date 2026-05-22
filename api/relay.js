/**
 * api/relay.js
 *
 * Server-side relay for AI API calls.
 * Routes requests to Anthropic, OpenAI, or Google based on model name.
 * No logging. No storage. Forwards and returns.
 *
 * Why this exists:
 *   All major AI providers block direct browser requests (CORS).
 *   This relay runs on Vercel (server-side) where CORS doesn't apply.
 *
 * Security:
 *   - User API keys are passed in the request body and used once, then discarded.
 *   - Vitnas never stores API keys.
 *   - If no user key, uses VITNAS_FREE_KEY env variable (limited model only).
 *
 * Supported models:
 *   - claude-*       → Anthropic API
 *   - gpt-*          → OpenAI API
 *   - gemini-*       → Google Generative AI API
 */

const https = require('https');

// ── Helpers ───────────────────────────────────────────────

function readBody(req) {
  return new Promise(function(resolve, reject) {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', function(c) { raw += c; });
    req.on('end',  function()  { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

function jsonRes(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function httpsPost(hostname, path, headers, body) {
  return new Promise(function(resolve, reject) {
    const data = JSON.stringify(body);
    const opts = {
      hostname, path,
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers)
    };
    const req = https.request(opts, function(res) {
      let raw = '';
      res.on('data', function(c) { raw += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Provider adapters ─────────────────────────────────────

async function callAnthropic(model, apiKey, system, messages, maxTokens) {
  const res = await httpsPost(
    'api.anthropic.com',
    '/v1/messages',
    {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    {
      model,
      max_tokens: maxTokens,
      system,
      messages
    }
  );

  if (res.status !== 200) {
    return { error: 'Anthropic error ' + res.status + ': ' + (res.body.error && res.body.error.message || JSON.stringify(res.body)) };
  }

  const text = res.body.content && res.body.content[0] && res.body.content[0].text;
  return { content: text || '' };
}

async function callOpenAI(model, apiKey, system, messages, maxTokens) {
  const oaiMessages = [{ role: 'system', content: system }].concat(messages);

  const res = await httpsPost(
    'api.openai.com',
    '/v1/chat/completions',
    { 'Authorization': 'Bearer ' + apiKey },
    { model, messages: oaiMessages, max_tokens: maxTokens }
  );

  if (res.status !== 200) {
    return { error: 'OpenAI error ' + res.status + ': ' + (res.body.error && res.body.error.message || JSON.stringify(res.body)) };
  }

  const text = res.body.choices && res.body.choices[0] && res.body.choices[0].message && res.body.choices[0].message.content;
  return { content: text || '' };
}

async function callGemini(model, apiKey, system, messages, maxTokens) {
  // Gemini uses a different message format
  const contents = messages.map(function(m) {
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  });

  // Prepend system as first user message if present
  if (system) {
    contents.unshift({ role: 'user', parts: [{ text: system }] });
    contents.splice(1, 0, { role: 'model', parts: [{ text: 'Understood.' }] });
  }

  const geminiModel = model.replace('gemini-', 'gemini-') ; // pass through
  const res = await httpsPost(
    'generativelanguage.googleapis.com',
    '/v1/models/' + geminiModel + ':generateContent?key=' + apiKey,
    {},
    {
      contents,
      generationConfig: { maxOutputTokens: maxTokens }
    }
  );

  if (res.status !== 200) {
    return { error: 'Gemini error ' + res.status + ': ' + JSON.stringify(res.body) };
  }

  const text = res.body.candidates &&
    res.body.candidates[0] &&
    res.body.candidates[0].content &&
    res.body.candidates[0].content.parts &&
    res.body.candidates[0].content.parts[0] &&
    res.body.candidates[0].content.parts[0].text;

  return { content: text || '' };
}

// ── Max tokens by verbosity ───────────────────────────────
function maxTokens(verbosity) {
  if (verbosity === 1) return 300;
  if (verbosity === 3) return 1500;
  return 700;
}

// ── Main handler ──────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    return jsonRes(res, 405, { error: 'Method not allowed.' });
  }

  let body;
  try { body = await readBody(req); }
  catch (e) { return jsonRes(res, 400, { error: 'Invalid request body.' }); }

  const { model, apiKey: userKey, system, messages, verbosity: verb } = body;

  if (!model || !messages || !Array.isArray(messages)) {
    return jsonRes(res, 400, { error: 'model and messages are required.' });
  }

  // Resolve API key
  // If user provides their own key, use it.
  // Otherwise use Vitnas free key from env (limited model only).
  let key = userKey && userKey.trim();
  let resolvedModel = model;

  if (!key) {
    key = process.env.VITNAS_FREE_KEY || '';
    resolvedModel = process.env.VITNAS_FREE_MODEL || 'gemini-1.5-flash-002';
    if (!key) {
      return jsonRes(res, 402, { error: 'No API key provided and no free key configured. Add your API key in the toolbar.' });
    }
  }

  const tokens = maxTokens(parseInt(verb, 10) || 2);
  const sys = system || 'You are a helpful assistant.';

  let result;
  try {
    if (resolvedModel.startsWith('claude')) {
      result = await callAnthropic(resolvedModel, key, sys, messages, tokens);
    } else if (resolvedModel.startsWith('gpt')) {
      result = await callOpenAI(resolvedModel, key, sys, messages, tokens);
    } else if (resolvedModel.startsWith('gemini')) {
      result = await callGemini(resolvedModel, key, sys, messages, tokens);
    } else {
      result = { error: 'Unknown model: ' + resolvedModel };
    }
  } catch (e) {
    result = { error: 'Provider call failed: ' + e.message };
  }

  if (result.error) {
    return jsonRes(res, 502, { error: result.error });
  }

  return jsonRes(res, 200, { content: result.content, model: resolvedModel });
};
