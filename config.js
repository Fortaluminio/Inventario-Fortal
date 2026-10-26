// Configuração do Supabase da VPS (Hostinger). A chave abaixo é a chave "anon",
// feita para ficar no código do app (não é secreta). A segurança de verdade vem do
// login (usuário e senha) e das políticas de RLS configuradas no banco.
window.SUPABASE_CONFIG = {
  url: 'https://supabase.fortalaluminio.digital',
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJyb2xlIjogImFub24iLAogICJpc3MiOiAic3VwYWJhc2UiLAogICJpYXQiOiAxNzE1MDUwODAwLAogICJleHAiOiAxODcyODE3MjAwCn0.rbcordCHD3YvP2bTdfj-V4xwbqntscyXqm2AhfxyAkA',
};
