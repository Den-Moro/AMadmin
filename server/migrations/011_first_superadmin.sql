-- Учётки панели теперь заводятся из самой панели (страница «Пользователи»), а не только
-- через bin/create-admin.php. Управлять учётками может лишь superadmin — и чтобы у
-- уже работающей установки был хотя бы один, самый первый administrator становится им.
UPDATE admin_users
SET role = 'superadmin'
WHERE id = (SELECT MIN(id) FROM admin_users WHERE role = 'administrator')
  AND NOT EXISTS (SELECT 1 FROM admin_users WHERE role = 'superadmin');
