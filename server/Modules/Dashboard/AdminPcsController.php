<?php

class AdminPcsController
{
    // ПК считается "онлайн", если опрашивал сервер недавно. Окно шире, чем максимальный
    // интервал опроса клиента (30-60 сек, см. AGENTS.md), чтобы обычная сетевая задержка
    // между опросами не превращалась в ложное мигание онлайн/офлайн на дашборде.
    const ONLINE_WINDOW_SECONDS = 180;

    // GET /admin/pcs?search=&store_id=&device_type_id=
    public static function index()
    {
        AdminAuth::requireLogin();

        $rows = self::query(
            isset($_GET['store_id']) && $_GET['store_id'] !== '' ? (int) $_GET['store_id'] : null,
            isset($_GET['device_type_id']) && $_GET['device_type_id'] !== '' ? (int) $_GET['device_type_id'] : null,
            isset($_GET['search']) ? trim($_GET['search']) : ''
        );

        // agent_token — это пароль кассы. Оператору список нужен, а ключи — нет: их
        // видят только те, кто может заводить ПК и выгружать конфиги (administrator+).
        if ($_SESSION['admin_role'] === 'operator') {
            foreach ($rows as &$row) {
                unset($row['agent_token']);
            }
            unset($row);
        }

        echo json_encode($rows);
    }

    // Общий запрос списка ПК: используется и для таблицы на дашборде, и для выгрузки
    // конфигов архивом — чтобы "что вижу в списке, то и выгружается" выполнялось само
    // собой, а фильтры не разъехались между двумя копиями одного SQL.
    private static function query($storeId, $deviceTypeId, $search)
    {
        $sql = "
            SELECT
                p.id, p.hostname, p.username, p.display_name, p.last_seen, p.agent_version,
                p.agent_token, p.store_id, p.device_type_id,
                s.name AS store_name,
                dt.name AS device_type_name,
                (julianday('now') - julianday(p.last_seen)) * 86400.0 AS seconds_since_seen
            FROM pcs p
            JOIN stores s ON s.id = p.store_id
            JOIN device_types dt ON dt.id = p.device_type_id
            WHERE 1 = 1
        ";
        $params = array();

        if ($storeId) {
            $sql .= ' AND p.store_id = :store_id';
            $params['store_id'] = $storeId;
        }
        if ($deviceTypeId) {
            $sql .= ' AND p.device_type_id = :device_type_id';
            $params['device_type_id'] = $deviceTypeId;
        }
        if ($search !== '') {
            $sql .= ' AND (p.hostname LIKE :search OR p.username LIKE :search OR p.display_name LIKE :search OR s.name LIKE :search)';
            $params['search'] = '%' . $search . '%';
        }

        $sql .= ' ORDER BY p.last_seen DESC';

        $stmt = Db::get()->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll();

        foreach ($rows as &$row) {
            $row['online'] = $row['last_seen'] !== null && $row['seconds_since_seen'] <= Settings::int('online_window_seconds', self::ONLINE_WINDOW_SECONDS);
            unset($row['seconds_since_seen']);
        }
        unset($row);

        return $rows;
    }

    // POST /admin/pcs   body: { store_id, device_type_id, hostname, display_name? }
    // Заводит ПК и сам генерирует agent_token — раньше это делалось только руками через
    // SQL (см. dev-seed.sql), из-за чего "легко получить готовый конфиг для новой кассы"
    // было просто неоткуда взять. Токен возвращаем в ответе один раз — панель сама
    // сразу показывает готовый config.json, копировать вручную из БД не нужно.
    public static function store()
    {
        // Заведение ПК выдаёт ключ доступа — тот же уровень, что и команды на кассы.
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $body = json_decode(file_get_contents('php://input'), true);
        $storeId = isset($body['store_id']) ? (int) $body['store_id'] : 0;
        $deviceTypeId = isset($body['device_type_id']) ? (int) $body['device_type_id'] : 0;
        $hostname = isset($body['hostname']) ? trim($body['hostname']) : '';
        $displayName = (!empty($body['display_name'])) ? trim($body['display_name']) : null;

        if (!$storeId || !$deviceTypeId || $hostname === '') {
            http_response_code(400);
            echo json_encode(array('error' => 'store_id_device_type_id_hostname_required'));
            return;
        }

        // random_bytes — криптографически стойкий генератор (не mt_rand/uniqid), это
        // секретный токен, который заменяет пароль для агента на этом ПК.
        $token = bin2hex(random_bytes(32));

        $stmt = Db::get()->prepare('
            INSERT INTO pcs (store_id, device_type_id, hostname, display_name, agent_token)
            VALUES (:store_id, :device_type_id, :hostname, :display_name, :token)
        ');
        $stmt->execute(array(
            'store_id'      => $storeId,
            'device_type_id' => $deviceTypeId,
            'hostname'      => $hostname,
            'display_name'  => $displayName,
            'token'         => $token,
        ));

        $id = Db::get()->lastInsertId();
        Logger::info("ПК создан вручную из панели: id={$id} hostname='{$hostname}' автор='{$_SESSION['admin_username']}'");

        echo json_encode(array('status' => 'ok', 'id' => $id, 'agent_token' => $token));
    }

    // PUT /admin/pcs/{id}   body: { display_name?, store_id?, device_type_id? }
    public static function update($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $id = (int) $id;
        $body = json_decode(file_get_contents('php://input'), true);
        $fields = array();
        $params = array('id' => $id);

        if (array_key_exists('display_name', $body)) {
            $fields[] = 'display_name = :display_name';
            $params['display_name'] = trim((string) $body['display_name']) !== '' ? trim($body['display_name']) : null;
        }
        if (!empty($body['store_id'])) {
            $fields[] = 'store_id = :store_id';
            $params['store_id'] = (int) $body['store_id'];
        }
        if (!empty($body['device_type_id'])) {
            $fields[] = 'device_type_id = :device_type_id';
            $params['device_type_id'] = (int) $body['device_type_id'];
        }
        if (!$fields) {
            http_response_code(400);
            echo json_encode(array('error' => 'nothing_to_update'));
            return;
        }

        $stmt = Db::get()->prepare('UPDATE pcs SET ' . implode(', ', $fields) . ' WHERE id = :id');
        $stmt->execute($params);
        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }

        Logger::info("ПК id={$id} изменён (" . implode(', ', array_keys(array_diff_key($params, array('id' => 1)))) . ") автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // POST /admin/pcs/{id}/token — выдать ПК новый ключ. Старый перестаёт работать сразу:
    // это способ «отозвать доступ», если конфиг с ключом утёк или касса ушла из парка.
    public static function regenerateToken($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $id = (int) $id;
        $token = bin2hex(random_bytes(32));
        $stmt = Db::get()->prepare('UPDATE pcs SET agent_token = :token WHERE id = :id');
        $stmt->execute(array('token' => $token, 'id' => $id));
        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }

        Logger::warning("ПК id={$id}: ключ перевыпущен, старый отозван автором='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'agent_token' => $token));
    }

    // DELETE /admin/pcs/{id} — вместе с историей подтверждений/результатов (ON DELETE CASCADE).
    public static function destroy($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $id = (int) $id;
        $stmt = Db::get()->prepare('DELETE FROM pcs WHERE id = :id');
        $stmt->execute(array('id' => $id));
        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }

        Logger::warning("ПК id={$id} удалён автором='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // POST /admin/pcs/bulk   body: { store_id, device_type_id, hostnames: "KASSA-01\nKASSA-02..." }
    // Заводит сразу пачку ПК: при развёртывании на магазин их десятки, по одному через
    // форму — это долго. Уже существующие hostname пропускаем, а не падаем на середине:
    // список обычно составляют вручную, и повтор в нём — норма, а не повод отменять всё.
    public static function bulkStore()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $body = json_decode(file_get_contents('php://input'), true);
        $storeId = isset($body['store_id']) ? (int) $body['store_id'] : 0;
        $deviceTypeId = isset($body['device_type_id']) ? (int) $body['device_type_id'] : 0;
        $raw = isset($body['hostnames']) ? (string) $body['hostnames'] : '';

        if (!$storeId || !$deviceTypeId) {
            http_response_code(400);
            echo json_encode(array('error' => 'store_id_and_device_type_id_required'));
            return;
        }

        $hostnames = array();
        foreach (preg_split('/[\r\n,;]+/', $raw) as $line) {
            $line = trim($line);
            if ($line !== '') {
                $hostnames[] = $line;
            }
        }

        if (empty($hostnames)) {
            http_response_code(400);
            echo json_encode(array('error' => 'hostnames_required'));
            return;
        }

        $db = Db::get();
        $existingStmt = $db->prepare('SELECT id FROM pcs WHERE hostname = :hostname AND store_id = :store_id');
        $insertStmt = $db->prepare('
            INSERT INTO pcs (store_id, device_type_id, hostname, agent_token)
            VALUES (:store_id, :device_type_id, :hostname, :token)
        ');

        $created = array();
        $skipped = array();

        $db->beginTransaction();
        try {
            foreach ($hostnames as $hostname) {
                $existingStmt->execute(array('hostname' => $hostname, 'store_id' => $storeId));
                if ($existingStmt->fetch()) {
                    $skipped[] = $hostname;
                    continue;
                }

                $insertStmt->execute(array(
                    'store_id'       => $storeId,
                    'device_type_id' => $deviceTypeId,
                    'hostname'       => $hostname,
                    'token'          => bin2hex(random_bytes(32)),
                ));
                $created[] = $hostname;
            }
            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            throw $e;
        }

        Logger::info(
            'Массовое создание ПК: добавлено ' . count($created) . ', пропущено (уже были) ' .
            count($skipped) . ", автор='{$_SESSION['admin_username']}'"
        );

        echo json_encode(array('status' => 'ok', 'created' => $created, 'skipped' => $skipped));
    }

    // GET /admin/pcs/configs.zip?store_id=&device_type_id=&search=
    // Отдаёт архив с готовыми config.json для каждой кассы (внутри — токен этой кассы).
    // Нужен, чтобы разложить конфиги по хостам своими средствами, не устанавливая ничего
    // на сами хосты: фильтры те же, что в списке ПК, — что видите, то и выгружается.
    public static function exportConfigs()
    {
        // Архив содержит ключи всех касс — только administrator+.
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        if (!class_exists('ZipArchive')) {
            http_response_code(500);
            echo json_encode(array('error' => 'zip_extension_missing'));
            Logger::error('Выгрузка конфигов невозможна: в PHP не включено расширение zip');
            return;
        }

        $pcs = self::query(
            isset($_GET['store_id']) && $_GET['store_id'] !== '' ? (int) $_GET['store_id'] : null,
            isset($_GET['device_type_id']) && $_GET['device_type_id'] !== '' ? (int) $_GET['device_type_id'] : null,
            isset($_GET['search']) ? trim($_GET['search']) : ''
        );

        if (empty($pcs)) {
            http_response_code(404);
            echo json_encode(array('error' => 'no_pcs_match_filter'));
            return;
        }

        // server_url для конфигов берём из адреса, по которому открыта панель: именно он
        // точно доступен снаружи (сам сервер за прокси своего внешнего адреса не знает).
        $serverUrl = isset($_GET['server_url']) && preg_match('#^https?://[^\s/]+$#i', rtrim($_GET['server_url'], '/'))
            ? rtrim($_GET['server_url'], '/')
            : (isset($_SERVER['HTTP_HOST']) ? 'http://' . $_SERVER['HTTP_HOST'] : 'http://localhost:8000');

        $tmp = tempnam(sys_get_temp_dir(), 'amadmin-configs');
        $zip = new ZipArchive();
        $zip->open($tmp, ZipArchive::OVERWRITE);

        $readme = "Здесь лежат готовые config.json для касс.\n\n" .
            "Как использовать: положите файл config.json из папки с именем кассы\n" .
            "рядом с программой агента на этой кассе. Больше ничего заполнять не нужно.\n\n" .
            "ВАЖНО: внутри лежат ключи доступа (agent_token) — по одному на кассу.\n" .
            "Храните архив как пароли и не пересылайте его открытыми каналами.\n\n" .
            "Сервер: {$serverUrl}\n" .
            'Выгружено: ' . gmdate('Y-m-d H:i:s') . " UTC\n";
        // BOM в начале: без него Блокнот на Windows читает UTF-8 как ANSI и вместо
        // русского текста показывает кракозябры — а эту записку читает человек.
        $zip->addFromString('ПРОЧТИ_МЕНЯ.txt', "ï»¿" . $readme);

        foreach ($pcs as $pc) {
            $config = array(
                'server_url'            => $serverUrl,
                'agent_token'           => $pc['agent_token'],
                'poll_interval_seconds' => 30,
                'log_level'             => 'debug',
                'proxy_url'             => '',
                'proxy_username'        => '',
                'proxy_password'        => '',
                'download_limit_kbps'   => 0,
            );

            // Имя папки — hostname, чтобы было очевидно, какой конфиг на какую кассу.
            $folder = preg_replace('/[^A-Za-z0-9_.\-]/', '_', $pc['hostname']);
            $zip->addFromString(
                $folder . '/config.json',
                json_encode($config, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
            );
        }

        $zip->close();

        Logger::info('Выгрузка конфигов: ' . count($pcs) . " шт., автор='{$_SESSION['admin_username']}'");

        header('Content-Type: application/zip');
        header('Content-Disposition: attachment; filename="amadmin-configs.zip"');
        header('Content-Length: ' . filesize($tmp));
        readfile($tmp);
        unlink($tmp);
    }
}
