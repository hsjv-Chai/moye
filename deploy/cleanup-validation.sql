-- Only removes data created by the isolated validation administrator.
-- Run after finishing the collaboration acceptance scripts and taking a backup.
BEGIN;
DELETE FROM books WHERE id IN (
  SELECT a.book_id FROM audit a JOIN users u ON u.id=a.user_id
  WHERE a.action='create-book' AND u.username='validation_admin' AND u.display_name='验收管理员'
);
DELETE FROM users WHERE username LIKE 'validation\_%' ESCAPE '\'
  AND display_name IN ('验收管理员','验收编辑者','验收只读者','停用验证');
COMMIT;
SELECT username,admin,active,must_change FROM users ORDER BY username;
