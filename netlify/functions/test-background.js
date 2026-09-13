console.log('[test-bg] MODULE LOAD at', new Date().toISOString());
export const handler = async (event) => {
  console.log('[test-bg] HANDLER CALLED', event?.httpMethod, (event?.body || '').length);
  await new Promise(r => setTimeout(r, 2000));
  console.log('[test-bg] HANDLER DONE');
  return { statusCode: 200, body: 'ok' };
};
