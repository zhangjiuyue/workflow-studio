export function assertDeploymentConfig(config,{separateWorker=false}={}) {
  if(config.env!=='production')return;
  if(String(config.sessionSecret||'').length<32)throw new Error('Production requires a unique SESSION_SECRET of at least 32 characters.');
  const encryptionKey=String(config.apiKeyEncryptionKey||'');
  if(!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey)||Buffer.from(encryptionKey,'base64').length!==32)throw new Error('Production API_KEY_ENCRYPTION_KEY must be 32 random bytes encoded as base64.');
  if(!config.appOrigins?.length||config.appOrigins.includes('*'))throw new Error('Production requires explicit APP_ORIGINS.');
  if(config.bootstrapAdmin?.password&&String(config.bootstrapAdmin.password).length<12)throw new Error('Bootstrap administrator password must contain at least 12 characters.');
  if(separateWorker&&config.store?.driver!=='postgres')throw new Error('A separate production worker requires PostgreSQL; use the local single-process runner for JSON storage.');
  if(config.store?.driver==='postgres'&&!config.databaseUrl)throw new Error('PostgreSQL requires DATABASE_URL.');
}
