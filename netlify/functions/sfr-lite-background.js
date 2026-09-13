// Minimal V1 API background function that beacons proof-sink-v1 on entry
export const handler = async (event) => {
  try {
    await fetch('https://bodyshopequipment.solutions/.netlify/functions/proof-sink-v1?src=sfr-lite', {
      method: 'POST', headers: {'content-type':'text/plain'},
      body: `sfr-lite ran at ${new Date().toISOString()} bodyLen=${(event?.body || '').length}`,
    });
  } catch(e) { /* ignore */ }
  return { statusCode: 200, body: 'ok' };
};
