export default async (req) => {
  const stamp = new Date().toISOString();
  try {
    await fetch('https://bodyshopequipment.solutions/.netlify/functions/proof-sink-v1?src=test3-bg-v2', {
      method: 'POST', headers: {'content-type':'text/plain'},
      body: `test3-background V2 API ran at ${stamp}`,
    });
  } catch(_) {}
  return new Response('ok');
};
