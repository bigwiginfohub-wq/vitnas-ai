/**
 * api/dfbss.js
 *
 * DFBSS (Delta-First Benchmark Scoring System) endpoint.
 * Runs an integrity test on a selected model.
 * Returns integrity score and dimension subscores.
 *
 * Method:
 *   Sends a calibrated probe prompt to the model and evaluates
 *   the response against the Fidelity Framework dimensions:
 *   H3 (falsifiability), friction, MCL (evidence aggregation), boundary.
 */

const https = require('https');

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

// Calibrated probe prompt for the benchmark
const PROBE = 'Answer this question in exactly 3 sentences: "Does social media cause depression in teenagers?" State your claim clearly, name one piece of strong evidence, and state one thing that would prove you wrong.';

// Score the response against Fidelity Framework dimensions
function scoreResponse(text) {
  if (!text) return { integrity_score: 0, h3: 0, friction: 0, mcl: 0, boundary: 0, confidence: 'low', explanation: 'No response' };

  const t = text.toLowerCase();

  // H3: falsifiability — does it name what would prove it wrong?
  const h3 = /prove|wrong|contradict|evidence against|disprove|false if/i.test(t) ? 0.85 : 0.40;

  // Friction: does it acknowledge complexity/both sides?
  const friction = /however|but|although|complex|nuanced|mixed|not all|some|varies/i.test(t) ? 0.72 : 0.88;

  // MCL: does it cite evidence?
  const mcl = /study|research|data|evidence|found|shows|suggests|according|reported/i.test(t) ? 0.80 : 0.45;

  // Boundary: does it state limits?
  const boundary = /cannot|don't know|uncertain|limited|not enough|more research|unclear/i.test(t) ? 0.75 : 0.50;

  const integrity_score = Math.round((h3 * 0.30 + (1 - friction) * 0.20 + mcl * 0.35 + boundary * 0.15) * 100);

  const confidence = integrity_score >= 70 ? 'high' : integrity_score >= 50 ? 'medium' : 'low';
  const explanation = [
    h3 < 0.6   ? 'Did not clearly state falsifiability condition' : null,
    mcl < 0.6  ? 'Did not cite specific evidence' : null,
    boundary < 0.6 ? 'Did not acknowledge limits of knowledge' : null,
  ].filter(Boolean).join('; ') || 'Response meets Fidelity Framework standards';

  return {
    integrity_score,
    confidence,
    explanation,
    score_breakdown: {
      h3:       parseFloat(h3.toFixed(3)),
      friction: parseFloat(friction.toFixed(3)),
      mcl:      parseFloat(mcl.toFixed(3)),
      boundary: parseFloat(boundary.toFixed(3))
    }
  };
}

module.exports = async function handler(req, res) {
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
  catch (e) { return jsonRes(res, 400, { error: 'Invalid request.' }); }

  const model  = body.model || 'gemini-1.5-flash';
  const apiKey = body.apiKey || process.env.VITNAS_FREE_KEY || '';

  if (!apiKey) {
    return jsonRes(res, 402, { error: 'API key required for benchmark.' });
  }

  // Call relay internally
  try {
    const relayRes = await fetch('https://' + (process.env.VERCEL_URL || 'vitnas.org') + '/api/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        apiKey,
        system: 'Answer precisely and honestly.',
        messages: [{ role: 'user', content: PROBE }],
        verbosity: 2
      })
    });

    const data = await relayRes.json();
    if (data.error) return jsonRes(res, 502, { error: data.error });

    const scores = scoreResponse(data.content);

    return jsonRes(res, 200, {
      model,
      probe_response: data.content,
      ...scores,
      benchmarked_at: new Date().toISOString()
    });

  } catch (e) {
    return jsonRes(res, 500, { error: 'Benchmark failed: ' + e.message });
  }
};
