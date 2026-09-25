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

        $rows = self::query(self::filtersFromRequest());

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

    // Фильтры списка из query string. Одни и те же для таблицы хостов и для выгрузки
    // конфигов архивом — "что вижу в списке, то и выгружается".
    //   store_id, device_type_id, group_id — привязки;
    //   search — hostname / пользователь / понятное имя / магазин;
    //   state — online | offline | never (ни разу не выходил) | silent (молчит > суток);
    //   ids — "1,2,3": только эти ПК (выгрузка конфигов для отмеченных строк).
    private static function filtersFromRequest()
    {
        return array(
            'store_id'       => isset($_GET['store_id']) && $_GET['store_id'] !== '' ? (int) $_GET['store_id'] : null,
            'device_type_id' => isset($_GET['device_type_id']) && $_GET['device_type_id'] !== '' ? (int) $_GET['device_type_id'] : null,
            'group_id'       => isset($_GET['group_id']) && $_GET['group_id'] !== '' ? (int) $_GET['group_id'] : null,
            'search'         => isset($_GET['search']) ? trim($_GET['search']) : '',
            'state'          => isset($_GET['state']) ? $_GET['state'] : '',
            'ids'            => isset($_GET['ids']) && $_GET['ids'] !== ''
                ? array_values(array_filter(array_map('intval', explode(',', $_GET['ids']))))
                : null,
        );
    }

    // Общий запрос списка ПК (см. filtersFromRequest).
    private static function query($f)
    {
        $window = Settings::int('online_window_seconds', self::ONLINE_WINDOW_SECONDS);
        $sql = "
            SELECT
                p.id, p.hostname, p.username, p.display_name, p.last_seen, p.agent_version, p.last_ip,
                p.agent_token, p.store_id, p.device_type_id, p.created_at,
                p.excluded_from_stats, p.excluded_reason,
                s.name AS store_name,
                dt.name AS device_type_name,
                (julianday('now') - julianday(p.last_seen)) * 86400.0 AS seconds_since_seen,
                (SELECT GROUP_CONCAT(g.name, ', ') FROM host_group_members m JOIN host_groups g ON g.id = m.group_id WHERE m.pc_id = p.id) AS groups
            FROM pcs p
            JOIN stores s ON s.id = p.store_id
            JOIN device_types dt ON dt.id = p.device_type_id
            WHERE 1 = 1
        ";
        $params = array();

        if (!empty($f['store_id'])) {
            $sql .= ' AND p.store_id = :store_id';
            $params['store_id'] = $f['store_id'];
        }
        if (!empty($f['device_type_id'])) {
            $sql .= ' AND p.device_type_id = :device_type_id';
            $params['device_type_id'] = $f['device_type_id'];
        }
        if (!empty($f['group_id'])) {
            $sql .= ' AND p.id IN (SELECT pc_id FROM host_group_members WHERE group_id = :group_id)';
            $params['group_id'] = $f['group_id'];
        }
        if ($f['search'] !== '') {
            $sql .= ' AND (p.hostname LIKE :search OR p.username LIKE :search OR p.display_name LIKE :search OR s.name LIKE :search)';
            $params['search'] = '%' . $f['search'] . '%';
        }
        switch ($f['state']) {
            case 'online':
                $sql .= " AND p.last_seen IS NOT NULL AND (julianday('now') - julianday(p.last_seen)) * 86400.0 <= {$window}";
                break;
            case 'offline':
                $sql .= " AND (p.last_seen IS NULL OR (julianday('now') - julianday(p.last_seen)) * 86400.0 > {$window})";
                break;
            case 'never':
                $sql .= ' AND p.last_seen IS NULL';
                break;
            case 'silent':
                $sql .= " AND p.last_seen IS NOT NULL AND (julianday('now') - julianday(p.last_seen)) > 1";
                break;
        }
        if (!empty($f['ids'])) {
            // Список чисел, собранный через intval — подставлять безопасно.
            $sql .= ' AND p.id IN (' . implode(',', $f['ids']) . ')';
        }

        $sql .= ' ORDER BY p.last_seen DESC';

        $stmt = Db::get()->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll();

        foreach ($rows as &$row) {
            $row['online'] = $row['last_seen'] !== null && $row['seconds_since_seen'] <= $window;
            unset($row['seconds_since_seen']);
        }
        unset($row);

        return $rows;
    }

    // GET /admin/pcs/{id} — профиль хоста: карточка, группы, последние подтверждения
    // оповещений и результаты команд именно этого ПК.
    public static function show($id)
    {
        AdminAuth::requireLogin();

        $rows = self::query(array('store_id' => null, 'device_type_id' => null, 'group_id' => null, 'search' => '', 'state' => '', 'ids' => array((int) $id)));
        if (!$rows) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        $pc = $rows[0];
        if ($_SESSION['admin_role'] === 'operator') {
            unset($pc['agent_token']);
        }

        $db = Db::get();
        $groups = $db->prepare('SELECT g.id, g.name FROM host_group_members m JOIN host_groups g ON g.id = m.group_id WHERE m.pc_id = :id ORDER BY g.name');
        $groups->execute(array('id' => $pc['id']));

        $acks = $db->prepare('
            SELECT a.acked_at, a.reacted, n.id AS notification_id, n.text, n.priority
            FROM notification_acks a
            JOIN notification_occurrences o ON o.id = a.occurrence_id
            JOIN notifications n ON n.id = o.notification_id
            WHERE a.pc_id = :id ORDER BY a.acked_at DESC LIMIT 20
        ');
        $acks->execute(array('id' => $pc['id']));

        $results = $db->prepare('
            SELECT r.status, r.output, r.claimed_at, r.executed_at, c.id AS command_id, c.type, c.payload, u.username AS author
            FROM command_results r
            JOIN commands c ON c.id = r.command_id
            LEFT JOIN admin_users u ON u.id = c.created_by
            WHERE r.pc_id = :id ORDER BY r.claimed_at DESC LIMIT 20
        ');
        $results->execute(array('id' => $pc['id']));

        $totals = $db->prepare("
            SELECT
                (SELECT COUNT(*) FROM notification_acks WHERE pc_id = :id1) AS acks,
                (SELECT COUNT(*) FROM command_results WHERE pc_id = :id2) AS results,
                (SELECT COUNT(*) FROM command_results WHERE pc_id = :id3 AND status IN ('failed', 'timeout')) AS failed
        ");
        $totals->execute(array('id1' => $pc['id'], 'id2' => $pc['id'], 'id3' => $pc['id']));

        echo json_encode(array(
            'pc'      => $pc,
            'groups'  => $groups->fetchAll(),
            'acks'    => $acks->fetchAll(),
            'results' => $results->fetchAll(),
            'totals'  => $totals->fetch(),
        ));
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
        if (array_key_exists('excluded_from_stats', $body)) {
            $fields[] = 'excluded_from_stats = :excluded_from_stats';
            $params['excluded_from_stats'] = !empty($body['excluded_from_stats']) ? 1 : 0;
        }
        if (array_key_exists('excluded_reason', $body)) {
            $fields[] = 'excluded_reason = :excluded_reason';
            $params['excluded_reason'] = trim((string) $body['excluded_reason']) !== '' ? trim($body['excluded_reason']) : null;
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

        $result = self::insertRows(array_map(function ($hostname) use ($storeId, $deviceTypeId) {
            return array('store_id' => $storeId, 'device_type_id' => $deviceTypeId, 'hostname' => $hostname, 'display_name' => null);
        }, $hostnames));

        Logger::info(
            'Массовое создание ПК: добавлено ' . count($result['created']) . ', пропущено (уже были) ' .
            count($result['skipped']) . ", автор='{$_SESSION['admin_username']}'"
        );

        echo json_encode(array('status' => 'ok', 'created' => $result['created'], 'skipped' => $result['skipped']));
    }

    // Общее ядро вставки пачки ПК — используется и «списком на весь магазин» (bulkStore,
    // один store_id/device_type_id на всю пачку), и импортом из файла (import, свои
    // store_id/device_type_id у каждой строки). Существующий hostname в том же магазине —
    // пропускаем, а не падаем на середине: список обычно составляют вручную, и повтор
    // в нём — норма, а не повод отменять всё остальное.
    //   $rows: [{store_id, device_type_id, hostname, display_name}, ...]
    //   -> ['created' => [hostname, ...], 'skipped' => [hostname, ...]]
    private static function insertRows(array $rows)
    {
        $db = Db::get();
        $existingStmt = $db->prepare('SELECT id FROM pcs WHERE hostname = :hostname AND store_id = :store_id');
        $insertStmt = $db->prepare('
            INSERT INTO pcs (store_id, device_type_id, hostname, display_name, agent_token)
            VALUES (:store_id, :device_type_id, :hostname, :display_name, :token)
        ');

        $created = array();
        $skipped = array();

        $db->beginTransaction();
        try {
            foreach ($rows as $row) {
                $existingStmt->execute(array('hostname' => $row['hostname'], 'store_id' => $row['store_id']));
                if ($existingStmt->fetch()) {
                    $skipped[] = $row['hostname'];
                    continue;
                }

                $insertStmt->execute(array(
                    'store_id'       => $row['store_id'],
                    'device_type_id' => $row['device_type_id'],
                    'hostname'       => $row['hostname'],
                    'display_name'   => !empty($row['display_name']) ? $row['display_name'] : null,
                    'token'          => bin2hex(random_bytes(32)),
                ));
                $created[] = $row['hostname'];
            }
            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            throw $e;
        }

        return array('created' => $created, 'skipped' => $skipped);
    }

    // POST /admin/pcs/import — multipart, поле "file" (.txt/.json/.xml, формат см.
    // importTemplate ниже и кнопку «ⓘ» в панели). Магазин/тип устройства матчатся по
    // названию без учёта регистра; несовпадение не заводит новый справочник молча —
    // строка уходит в errors, чтобы админ поправил файл и перезалил, а не гадал,
    // откуда взялся лишний магазин.
    public static function import()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
            http_response_code(400);
            echo json_encode(array('error' => 'file_required'));
            return;
        }

        $ext = strtolower(pathinfo($_FILES['file']['name'], PATHINFO_EXTENSION));
        $parsers = array('txt' => 'parseTxt', 'json' => 'parseJson', 'xml' => 'parseXml');
        if (!isset($parsers[$ext])) {
            http_response_code(400);
            echo json_encode(array('error' => 'unsupported_file_type'));
            return;
        }

        $content = file_get_contents($_FILES['file']['tmp_name']);
        try {
            $parsed = self::{$parsers[$ext]}($content);
        } catch (Exception $e) {
            http_response_code(400);
            echo json_encode(array('error' => 'parse_failed', 'message' => $e->getMessage()));
            return;
        }

        $db = Db::get();
        $stores = array();
        foreach ($db->query('SELECT id, name FROM stores')->fetchAll() as $s) {
            $stores[mb_strtolower(trim($s['name']))] = (int) $s['id'];
        }
        $deviceTypes = array();
        foreach ($db->query('SELECT id, name FROM device_types')->fetchAll() as $t) {
            $deviceTypes[mb_strtolower(trim($t['name']))] = (int) $t['id'];
        }

        $rows = array();
        $errors = array();
        foreach ($parsed as $i => $line) {
            $rowNum = $i + 1;
            $hostname = trim($line['hostname']);
            $storeName = trim($line['store']);
            $typeName = trim($line['device_type']);
            $displayName = trim($line['display_name']);

            if ($hostname === '') {
                $errors[] = array('row' => $rowNum, 'reason' => 'hostname_required');
                continue;
            }
            if (!isset($stores[mb_strtolower($storeName)])) {
                $errors[] = array('row' => $rowNum, 'hostname' => $hostname, 'reason' => 'store_not_found', 'value' => $storeName);
                continue;
            }
            if (!isset($deviceTypes[mb_strtolower($typeName)])) {
                $errors[] = array('row' => $rowNum, 'hostname' => $hostname, 'reason' => 'device_type_not_found', 'value' => $typeName);
                continue;
            }

            $rows[] = array(
                'store_id' => $stores[mb_strtolower($storeName)],
                'device_type_id' => $deviceTypes[mb_strtolower($typeName)],
                'hostname' => $hostname,
                'display_name' => $displayName !== '' ? $displayName : null,
            );
        }

        $result = $rows ? self::insertRows($rows) : array('created' => array(), 'skipped' => array());

        Logger::info(
            "Импорт ПК из файла .{$ext}: добавлено " . count($result['created']) . ', пропущено ' .
            count($result['skipped']) . ', ошибок ' . count($errors) . ", автор='{$_SESSION['admin_username']}'"
        );

        echo json_encode(array('status' => 'ok', 'created' => $result['created'], 'skipped' => $result['skipped'], 'errors' => $errors));
    }

    // .txt: "hostname;магазин;тип_устройства;понятное_имя(необязательно)" по строке,
    // строки, начинающиеся с #, — комментарии и пропускаются.
    private static function parseTxt($content)
    {
        $rows = array();
        foreach (preg_split('/\r\n|\r|\n/', (string) $content) as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#') {
                continue;
            }
            $parts = array_map('trim', explode(';', $line));
            $rows[] = array(
                'hostname'     => isset($parts[0]) ? $parts[0] : '',
                'store'        => isset($parts[1]) ? $parts[1] : '',
                'device_type'  => isset($parts[2]) ? $parts[2] : '',
                'display_name' => isset($parts[3]) ? $parts[3] : '',
            );
        }
        return $rows;
    }

    // .json: [{"hostname":"...","store":"...","device_type":"...","display_name":"..."}]
    private static function parseJson($content)
    {
        $data = json_decode((string) $content, true);
        if (!is_array($data)) {
            throw new Exception('invalid_json');
        }
        $rows = array();
        foreach ($data as $item) {
            if (!is_array($item)) {
                continue;
            }
            $rows[] = array(
                'hostname'     => isset($item['hostname']) ? (string) $item['hostname'] : '',
                'store'        => isset($item['store']) ? (string) $item['store'] : '',
                'device_type'  => isset($item['device_type']) ? (string) $item['device_type'] : '',
                'display_name' => isset($item['display_name']) ? (string) $item['display_name'] : '',
            );
        }
        return $rows;
    }

    // .xml: <hosts><host hostname="..." store="..." device_type="..." display_name="..."/></hosts>
    private static function parseXml($content)
    {
        libxml_use_internal_errors(true);
        $xml = @simplexml_load_string((string) $content);
        if ($xml === false) {
            throw new Exception('invalid_xml');
        }
        $rows = array();
        foreach ($xml->host as $host) {
            $attrs = $host->attributes();
            $rows[] = array(
                'hostname'     => isset($attrs['hostname']) ? (string) $attrs['hostname'] : '',
                'store'        => isset($attrs['store']) ? (string) $attrs['store'] : '',
                'device_type'  => isset($attrs['device_type']) ? (string) $attrs['device_type'] : '',
                'display_name' => isset($attrs['display_name']) ? (string) $attrs['display_name'] : '',
            );
        }
        return $rows;
    }

    // GET /admin/pcs/import/template?format=txt|json|xml — образец файла для импорта,
    // тот же формат, что описывает кнопка «ⓘ» в панели. Статичный пример, без похода в БД.
    public static function importTemplate()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $format = isset($_GET['format']) ? $_GET['format'] : 'txt';
        $samples = array(
            'txt' => "# hostname;магазин;тип_устройства;понятное_имя (необязательно)\r\n" .
                "KASSA-01;Тестовый магазин;Касса;Касса у входа\r\nKASSA-02;Тестовый магазин;Касса\r\n",
            'json' => json_encode(array(
                array('hostname' => 'KASSA-01', 'store' => 'Тестовый магазин', 'device_type' => 'Касса', 'display_name' => 'Касса у входа'),
                array('hostname' => 'KASSA-02', 'store' => 'Тестовый магазин', 'device_type' => 'Касса'),
            ), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n",
            'xml' => "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<hosts>\r\n" .
                "    <host hostname=\"KASSA-01\" store=\"Тестовый магазин\" device_type=\"Касса\" display_name=\"Касса у входа\"/>\r\n" .
                "    <host hostname=\"KASSA-02\" store=\"Тестовый магазин\" device_type=\"Касса\"/>\r\n</hosts>\r\n",
        );
        $mimes = array('txt' => 'text/plain', 'json' => 'application/json', 'xml' => 'application/xml');

        if (!isset($samples[$format])) {
            http_response_code(400);
            echo json_encode(array('error' => 'unsupported_file_type'));
            return;
        }

        header('Content-Type: ' . $mimes[$format] . '; charset=utf-8');
        header('Content-Disposition: attachment; filename="amadmin-import-template.' . $format . '"');
        echo $samples[$format];
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

        $pcs = self::query(self::filtersFromRequest());

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
