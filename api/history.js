/**
 * GET /api/history?limit=20
 * 读取起名历史（用于页面「历史记录」列表）
 */
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: '只支持 GET 请求' });
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    res.status(200).json({ items: [], configured: false, message: '未配置 Supabase，历史记录不可用' });
    return;
  }

  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 20, 1), 50);
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data, error } = await supabase
    .from('name_history')
    .select('id, user_requirement, name_result, model_name, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    res.status(200).json({ items: [], configured: true, message: `读取历史失败：${error.message}` });
    return;
  }

  res.status(200).json({ items: data || [], configured: true });
};
