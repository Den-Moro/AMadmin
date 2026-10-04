<?php

// Версии агента (страница «Обновления»). Версия — номер, статус (тестовая / стабильная /
// отозвана), описание изменений и набор файлов из библиотеки deploy_files. Раскатка
// любой версии, в том числе старой (откат), — обычная пачка file_deploy-команд в папку
// агента (AdminCommandsController::createFileBatch) с release_id для истории. Агенту
// на кассе всё равно, новее версия или старше: он сравнивает хеши, кладёт файлы и
// перезапускается, если заменён его собственный .exe.
class AdminReleasesController
{
    const STATUSES = array('testing', 'stable', 'bad');

    // GET /admin/agent-releases — версии, новые сверху (по номеру), с файлами и историей раскаток.
    public static function index()
    {
        AdminAuth::requireLogin();

        $db = Db::get();
        $releases = $db->query("
            SELECT r.id, r.version, r.status, r.notes, r.created_at, r.status_changed_at, u.username AS created_by_username,
                   (SELECT COUNT(DISTINCT c.update_batch_id) FROM commands c WHERE c.release_id = r.id) AS deploy_count,
                   (SELECT MAX(c.created_at) FROM commands c WHERE c.release_id = r.id) AS last_deployed_at
            FROM agent_releases r
            LEFT JOIN admin_users u ON u.id = r.created_by
        ")->fetchAll();

        $files = $db->query('
            SELECT rf.release_id, f.id, f.original_name, f.size, f.sha256, f.pe_version
            FROM agent_release_files rf JOIN deploy_files f ON f.id = rf.file_id
            ORDER BY f.original_name
        ')->fetchAll();
        // Команды последней раскатки каждой версии — ссылка «смотреть выполнение».
        $lastBatch = $db->query('
            SELECT c.release_id, c.id FROM commands c
            WHERE c.release_id IS NOT NULL AND c.update_batch_id = (
                SELECT c2.update_batch_id FROM commands c2 WHERE c2.release_id = c.release_id ORDER BY c2.id DESC LIMIT 1
            )
        ')->fetchAll();

        foreach ($releases as &$r) {
            $r['files'] = array();
            $r['last_batch_command_ids'] = array();
            foreach ($files as $f) {
                if ((int) $f['release_id'] === (int) $r['id']) {
                    unset($f['release_id']);
                    $r['files'][] = $f;
                }
            }
            foreach ($lastBatch as $c) {
                if ((int) $c['release_id'] === (int) $r['id']) {
                    $r['last_batch_command_ids'][] = (int) $c['id'];
                }
            }
        }
        unset($r);

        usort($releases, function ($a, $b) {
            return VersionCompare::compare($b['version'], $a['version']);
        });

        echo json_encode(array(
            'releases'    => $releases,
            'install_dir' => Settings::get('agent_install_dir', 'C:\\AMadmin'),
            'current'     => Settings::get('current_agent_version', ''),
        ));
    }

    // POST /admin/agent-releases   body: { version, status?, notes?, file_ids: [...] }
    public static function store()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $body = json_decode(file_get_contents('php://input'), true);
        $version = self::normalizeVersion(isset($body['version']) ? $body['version'] : '');
        if ($version === null) {
            self::fail('version_invalid');
            return;
        }
        $status = isset($body['status']) ? $body['status'] : 'testing';
        if (!in_array($status, self::STATUSES, true)) {
            self::fail('invalid_status');
            return;
        }
        $notes = isset($body['notes']) ? trim($body['notes']) : '';

        $exists = Db::get()->prepare('SELECT 1 FROM agent_releases WHERE version = :v');
        $exists->execute(array('v' => $version));
        if ($exists->fetchColumn()) {
            self::fail('version_exists');
            return;
        }

        $fileIds = isset($body['file_ids']) && is_array($body['file_ids']) ? array_values(array_unique(array_map('intval', $body['file_ids']))) : array();
        $checked = self::checkFiles($fileIds);
        if (isset($checked['error'])) {
            self::fail($checked['error'], $checked);
            return;
        }

        $db = Db::get();
        $db->beginTransaction();
        try {
            $db->prepare('INSERT INTO agent_releases (version, status, notes, created_by) VALUES (:v, :s, :n, :u)')
                ->execute(array('v' => $version, 's' => $status, 'n' => $notes !== '' ? $notes : null, 'u' => $_SESSION['admin_id']));
            $id = (int) $db->lastInsertId();
            $link = $db->prepare('INSERT INTO agent_release_files (release_id, file_id) VALUES (:r, :f)');
            foreach ($fileIds as $fid) {
                $link->execute(array('r' => $id, 'f' => $fid));
            }
            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            throw $e;
        }

        Logger::info("Версия агента сохранена: {$version} статус={$status} файлов=" . count($fileIds) . " автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'id' => $id, 'version' => $version));
    }

    // PUT /admin/agent-releases/{id}   body: { status?, notes?, version? }
    public static function update($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $release = self::find($id);
        if (!$release) {
            self::fail('not_found', array(), 404);
            return;
        }
        $body = json_decode(file_get_contents('php://input'), true);

        $sets = array();
        $params = array('id' => (int) $id);
        if (isset($body['status'])) {
            if (!in_array($body['status'], self::STATUSES, true)) {
                self::fail('invalid_status');
                return;
            }
            if ($body['status'] !== $release['status']) {
                $sets[] = "status = :status, status_changed_at = CURRENT_TIMESTAMP";
                $params['status'] = $body['status'];
            }
        }
        if (array_key_exists('notes', $body)) {
            $sets[] = 'notes = :notes';
            $params['notes'] = trim((string) $body['notes']) !== '' ? trim($body['notes']) : null;
        }
        if (isset($body['version'])) {
            $version = self::normalizeVersion($body['version']);
            if ($version === null) {
                self::fail('version_invalid');
                return;
            }
            $dup = Db::get()->prepare('SELECT 1 FROM agent_releases WHERE version = :v AND id <> :id');
            $dup->execute(array('v' => $version, 'id' => (int) $id));
            if ($dup->fetchColumn()) {
                self::fail('version_exists');
                return;
            }
            $sets[] = 'version = :version';
            $params['version'] = $version;
        }
        if (!$sets) {
            self::fail('nothing_to_update');
            return;
        }

        Db::get()->prepare('UPDATE agent_releases SET ' . implode(', ', $sets) . ' WHERE id = :id')->execute($params);
        Logger::info("Версия агента {$release['version']} изменена: " . json_encode(array_diff_key($params, array('id' => 1)), JSON_UNESCAPED_UNICODE) . " автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // DELETE /admin/agent-releases/{id} — версия и её файлы (если они не входят в другую
    // версию). История команд остаётся: в каждой записан полный путь и имя файла.
    public static function destroy($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $release = self::find($id);
        if (!$release) {
            self::fail('not_found', array(), 404);
            return;
        }

        $db = Db::get();
        $files = $db->prepare('
            SELECT f.id, f.sha256 FROM agent_release_files rf JOIN deploy_files f ON f.id = rf.file_id
            WHERE rf.release_id = :id
              AND NOT EXISTS (SELECT 1 FROM agent_release_files o WHERE o.file_id = f.id AND o.release_id <> :id)
        ');
        $files->execute(array('id' => (int) $id));
        $orphans = $files->fetchAll();

        $db->prepare('DELETE FROM agent_releases WHERE id = :id')->execute(array('id' => (int) $id));
        foreach ($orphans as $f) {
            AdminFilesController::deleteRow($f['id'], $f['sha256']);
        }

        Logger::info("Версия агента {$release['version']} удалена вместе с файлами (" . count($orphans) . ") автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // POST /admin/agent-releases/{id}/deploy
    //   body: { target: {type, id}, install_dir?, make_current? }
    public static function deploy($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $release = self::find($id);
        if (!$release) {
            self::fail('not_found', array(), 404);
            return;
        }
        // Отозванную версию не раскатываем: чтобы всё-таки отправить, сначала явно
        // сменить ей статус — это осознанное действие, видимое в логе.
        if ($release['status'] === 'bad') {
            self::fail('release_is_bad');
            return;
        }

        $body = json_decode(file_get_contents('php://input'), true);
        $target = isset($body['target']) && is_array($body['target']) ? $body['target'] : array();
        $targetType = isset($target['type']) ? $target['type'] : '';
        $targetId = !empty($target['id']) ? (int) $target['id'] : null;
        if (!in_array($targetType, array('all', 'store', 'group', 'pc', 'device_type'), true)) {
            self::fail('invalid_target_type');
            return;
        }
        if ($targetType !== 'all' && !$targetId) {
            self::fail('target_id_required');
            return;
        }

        $dir = AdminDeployDestinationsController::normalizeFolder(
            isset($body['install_dir']) && trim($body['install_dir']) !== '' ? $body['install_dir'] : Settings::get('agent_install_dir', 'C:\\AMadmin')
        );
        if ($dir === null) {
            self::fail('install_dir_must_be_absolute_windows_path');
            return;
        }

        $files = Db::get()->prepare('
            SELECT f.id, f.original_name FROM agent_release_files rf JOIN deploy_files f ON f.id = rf.file_id
            WHERE rf.release_id = :id ORDER BY f.original_name
        ');
        $files->execute(array('id' => (int) $id));
        $payloads = array();
        foreach ($files->fetchAll() as $f) {
            $payloads[] = array(
                'file_id'     => $f['id'],
                'target_path' => (substr($dir, -1) === '\\' ? $dir : $dir . '\\') . $f['original_name'],
            );
        }
        if (!$payloads) {
            self::fail('release_has_no_files');
            return;
        }

        $result = AdminCommandsController::createFileBatch($payloads, $targetType, $targetId, (int) $id);
        if (isset($result['error'])) {
            self::fail($result['error'], $result);
            return;
        }

        Settings::set('agent_install_dir', $dir);
        if (!empty($body['make_current'])) {
            Settings::set('current_agent_version', $release['version']);
        }

        Logger::info(
            "Раскатка версии агента {$release['version']} (статус {$release['status']}) в {$dir}: batch={$result['update_batch_id']}" .
            " таргет={$targetType}" . ($targetId ? ":{$targetId}" : '') .
            (!empty($body['make_current']) ? ' + стала актуальной' : '') . " автор='{$_SESSION['admin_username']}'"
        );
        echo json_encode($result);
    }

    // GET /admin/agent-releases/import — что можно собрать в версии из файлов агента,
    // загруженных раньше (до появления версий): AMadmin.*, ещё не входящие ни в одну
    // версию, сгруппированные по версии из ресурса файла.
    public static function importPreview()
    {
        AdminAuth::requireLogin();
        echo json_encode(array('versions' => self::importCandidates()));
    }

    // POST /admin/agent-releases/import — создать эти версии. Версия, на которой сейчас
    // больше всего касс, получает статус «стабильная» (на ней реально работают), прочие —
    // «тестовая»; статус потом можно поменять.
    public static function import()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $candidates = self::importCandidates();
        $popular = self::mostReportedVersion();
        $db = Db::get();
        $created = array();
        foreach ($candidates as $c) {
            $status = $c['version'] === $popular ? 'stable' : 'testing';
            $db->beginTransaction();
            try {
                $db->prepare('INSERT INTO agent_releases (version, status, notes, created_by) VALUES (:v, :s, :n, :u)')->execute(array(
                    'v' => $c['version'], 's' => $status, 'u' => $_SESSION['admin_id'],
                    'n' => 'Собрана из файлов, загруженных раньше (до появления версий). Допишите, что в ней изменилось.',
                ));
                $rid = (int) $db->lastInsertId();
                $link = $db->prepare('INSERT INTO agent_release_files (release_id, file_id) VALUES (:r, :f)');
                foreach ($c['files'] as $f) {
                    $link->execute(array('r' => $rid, 'f' => $f['id']));
                }
                $db->commit();
            } catch (Exception $e) {
                $db->rollBack();
                throw $e;
            }
            $created[] = array('version' => $c['version'], 'status' => $status);
        }

        Logger::info('Версии агента собраны из ранее загруженных файлов: ' . json_encode($created, JSON_UNESCAPED_UNICODE) . " автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'created' => $created));
    }

    // ---- Помощники ----------------------------------------------------------------

    private static function importCandidates()
    {
        $db = Db::get();
        $rows = $db->query("
            SELECT f.id, f.original_name, f.sha256, f.pe_version FROM deploy_files f
            WHERE f.original_name LIKE 'AMadmin.%'
              AND NOT EXISTS (SELECT 1 FROM agent_release_files rf WHERE rf.file_id = f.id)
            ORDER BY f.id DESC
        ")->fetchAll();

        $existing = $db->query('SELECT version FROM agent_releases')->fetchAll(PDO::FETCH_COLUMN);
        $cache = $db->prepare('UPDATE deploy_files SET pe_version = :v WHERE id = :id');
        $byVersion = array();
        foreach ($rows as $f) {
            $v = $f['pe_version'];
            if ($v === null) {
                // Загружены до того, как сервер стал читать версию, — читаем сейчас и запоминаем.
                $v = PeVersion::read(FileStorage::path($f['sha256']));
                if ($v !== null) {
                    $cache->execute(array('v' => $v, 'id' => $f['id']));
                }
            }
            if ($v === null || in_array($v, $existing, true)) {
                continue;
            }
            // Один файл каждого имени на версию — самый свежий (строки уже по убыванию id).
            $key = strtolower($f['original_name']);
            if (!isset($byVersion[$v][$key])) {
                $byVersion[$v][$key] = array('id' => (int) $f['id'], 'original_name' => $f['original_name']);
            }
        }

        $out = array();
        foreach ($byVersion as $v => $files) {
            $out[] = array('version' => (string) $v, 'files' => array_values($files));
        }
        usort($out, function ($a, $b) { return VersionCompare::compare($b['version'], $a['version']); });
        return $out;
    }

    private static function mostReportedVersion()
    {
        $row = Db::get()->query("
            SELECT agent_version, COUNT(*) AS n FROM pcs WHERE agent_version IS NOT NULL AND agent_version <> ''
            GROUP BY agent_version ORDER BY n DESC LIMIT 1
        ")->fetch();
        return $row ? $row['agent_version'] : null;
    }

    // Файлы версии: существуют, имена не повторяются, без config.json — он у каждой
    // кассы свой (ключ доступа), раскатка одного на все сломала бы связь всем кассам.
    private static function checkFiles(array $fileIds)
    {
        if (!$fileIds) {
            return array('error' => 'files_required');
        }
        $in = implode(',', array_fill(0, count($fileIds), '?'));
        $stmt = Db::get()->prepare("SELECT id, original_name FROM deploy_files WHERE id IN ({$in})");
        $stmt->execute($fileIds);
        $rows = $stmt->fetchAll();
        if (count($rows) !== count($fileIds)) {
            return array('error' => 'file_not_found');
        }
        $names = array();
        foreach ($rows as $r) {
            $lower = strtolower($r['original_name']);
            if ($lower === 'config.json') {
                return array('error' => 'config_json_forbidden');
            }
            if (isset($names[$lower])) {
                return array('error' => 'duplicate_file_names', 'name' => $r['original_name']);
            }
            $names[$lower] = true;
        }
        return array('ok' => true);
    }

    // '0.2' -> '0.2.0'; null — не похоже на номер версии (агент сообщает три части).
    private static function normalizeVersion($v)
    {
        $v = trim((string) $v);
        if (!preg_match('/^\d{1,5}(\.\d{1,5}){1,2}$/', $v)) {
            return null;
        }
        $parts = explode('.', $v);
        while (count($parts) < 3) {
            $parts[] = '0';
        }
        return implode('.', array_map('intval', $parts));
    }

    private static function find($id)
    {
        $stmt = Db::get()->prepare('SELECT * FROM agent_releases WHERE id = :id');
        $stmt->execute(array('id' => (int) $id));
        return $stmt->fetch();
    }

    private static function fail($code, $extra = array(), $http = 400)
    {
        http_response_code($http);
        unset($extra['error']);
        echo json_encode(array_merge(array('error' => $code), $extra));
    }
}
