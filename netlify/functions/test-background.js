export const handler = async (event) => {
  const stamp = new Date().toISOString();
  try {
    await fetch('https://bodyshopequipment.solutions/.netlify/functions/proof-sink-v1?src=test-bg-v1', {
      method: 'POST', headers: {'content-type':'text/plain'},
      body: `test-background V1 API ran at ${stamp}`,
    });
  } catch(_) {}
  return { statusCode: 200, body: 'ok' };
};
