<?php

// Магазины как главная единица группировки касс (страница «Магазины» и страница
// магазина). Создание/правка/удаление самого магазина — AdminMetaController (справочник);
// здесь — сводка по кассам, подсети магазина и перевод касс между магазинами.
//
// Подсети магазина (stores.subnets, CIDR через запятую) никогда не переносят кассу сами:
// по IP её последнего опроса панель подсказывает «похоже, эта касса из того магазина» и
// раскладывает по кнопке, с подтверждением. Если IP подходит под подсети нескольких
// магазинов, побеждает более точная подсеть (длиннее маска) — /24 важнее /16.
class AdminStoresController
{
    // GET /admin/stores — магазины со сводкой: сколько касс, на связи, ни разу не выходили,
    // цвет состояния (пороги — network_site_status_*), сколько касс из других магазинов
    // по IP похожи на этот (suggest_count).
    public static function index()
    {
        AdminAuth::requireLogin();
        $stores = self::withStats(Db::get()->query('SELECT id, name, is_pilot, brand_name, brand_contact, subnets FROM stores ORDER BY name')->fetchAll());
        echo json_encode($stores);
    }

    // GET /admin/stores/{id}
    public static function show($id)
    {
        AdminAuth::requireLogin();
        $stmt = Db::get()->prepare('SELECT id, name, is_pilot, brand_name, brand_contact, subnets FROM stores WHERE id = :id');
        $stmt->execute(array('id' => (int) $id));
        $store = $stmt->fetch();
        if (!$store) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        $list = self::withStats(array($store));
        echo json_encode($list[0]);
    }

    // GET /admin/stores/auto-assign — какие кассы по IP стоят не в своём магазине:
    // [{pc_id, hostname, display_name, last_ip, from_store_id, from_store, to_store_id, to_store}].
    public static function autoAssignPreview()
    {
        AdminAuth::requireLogin();
        echo json_encode(self::misplaced(null));
    }

    // GET /admin/stores/{id}/suggestions — то же, только кассы, которые по IP относятся
    // к этому магазину, а числятся в другом.
    public static function suggestions($id)
    {
        AdminAuth::requireLogin();
        echo json_encode(self::misplaced((int) $id));
    }

    // POST /admin/stores/auto-assign   body: { pc_ids: [...] } — перевести перечисленные
    // кассы в магазин по их подсети. Перепроверяем на сервере: касса переезжает, только
    // если по текущему IP её магазин действительно другой.
    public static function autoAssign()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));
        $body = json_decode(file_get_contents('php://input'), true);
        $ids = isset($body['pc_ids']) && is_array($body['pc_ids']) ? array_map('intval', $body['pc_ids']) : array();

        $moved = 0;
        $move = Db::get()->prepare('UPDATE pcs SET store_id = :store WHERE id = :id');
        foreach (self::misplaced(null) as $m) {
            if (in_array((int) $m['pc_id'], $ids, true)) {
                $move->execute(array('store' => $m['to_store_id'], 'id' => $m['pc_id']));
                Logger::info("Касса {$m['hostname']} (id={$m['pc_id']}, IP {$m['last_ip']}) переведена по подсети: «{$m['from_store']}» -> «{$m['to_store']}» автор='{$_SESSION['admin_username']}'");
                $moved++;
            }
        }
        echo json_encode(array('status' => 'ok', 'moved' => $moved));
    }

    // POST /admin/pcs/move   body: { pc_ids: [...], store_id } — перевести кассы в магазин.
    // У кассы меняется только магазин: ключ, группы и история остаются; оповещения и
    // команды «магазину» она начнёт получать по новому магазину со следующего опроса.
    public static function movePcs()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));
        $body = json_decode(file_get_contents('php://input'), true);
        $ids = isset($body['pc_ids']) && is_array($body['pc_ids']) ? array_values(array_filter(array_map('intval', $body['pc_ids']))) : array();
        $storeId = isset($body['store_id']) ? (int) $body['store_id'] : 0;
        if (!$ids) {
            http_response_code(400);
            echo json_encode(array('error' => 'pc_ids_required'));
            return;
        }
        $store = Db::get()->prepare('SELECT name FROM stores WHERE id = :id');
        $store->execute(array('id' => $storeId));
        $storeName = $store->fetchColumn();
        if ($storeName === false) {
            http_response_code(400);
            echo json_encode(array('error' => 'store_not_found'));
            return;
        }

        $in = implode(',', $ids); // числа после intval — подставлять безопасно
        $moved = Db::get()->exec("UPDATE pcs SET store_id = {$storeId} WHERE id IN ({$in}) AND store_id <> {$storeId}");
        Logger::info("Кассы переведены в магазин «{$storeName}» (id={$storeId}): pc_ids={$in}, переведено={$moved} автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'moved' => $moved));
    }

    // ---- Помощники ----------------------------------------------------------------

    // Подсети строкой «a, b» -> массив CIDR; null — какая-то из них неверная.
    public static function parseSubnets($text)
    {
        $out = array();
        foreach (preg_split('/[\s,;]+/', trim((string) $text)) as $cidr) {
            if ($cidr === '') {
                continue;
            }
            if (!preg_match('#^(\d{1,3}(\.\d{1,3}){3})/(\d{1,2})$#', $cidr, $m) || ip2long($m[1]) === false || (int) $m[3] > 32) {
                return null;
            }
            $out[] = $cidr;
        }
        return $out;
    }

    private static function withStats(array $stores)
    {
        $window = Settings::int('online_window_seconds', AdminPcsController::ONLINE_WINDOW_SECONDS);
        $greenMin = Settings::int('network_site_status_green_min_percent', 100);
        $redMax = Settings::int('network_site_status_red_max_percent', 0);
        $stats = array();
        foreach (Db::get()->query("
            SELECT store_id,
                   COUNT(*) AS pc_count,
                   SUM(last_seen IS NOT NULL AND (julianday('now') - julianday(last_seen)) * 86400.0 <= {$window}) AS online_count,
                   SUM(last_seen IS NULL) AS never_count,
                   MAX(last_seen) AS last_seen
            FROM pcs GROUP BY store_id
        ")->fetchAll() as $row) {
            $stats[$row['store_id']] = $row;
        }
        $suggest = array();
        foreach (self::misplaced(null) as $m) {
            $suggest[$m['to_store_id']] = (isset($suggest[$m['to_store_id']]) ? $suggest[$m['to_store_id']] : 0) + 1;
        }

        foreach ($stores as &$s) {
            $st = isset($stats[$s['id']]) ? $stats[$s['id']] : array('pc_count' => 0, 'online_count' => 0, 'never_count' => 0, 'last_seen' => null);
            $s['pc_count'] = (int) $st['pc_count'];
            $s['online_count'] = (int) $st['online_count'];
            $s['never_count'] = (int) $st['never_count'];
            $s['last_seen'] = $st['last_seen'];
            $s['suggest_count'] = isset($suggest[$s['id']]) ? $suggest[$s['id']] : 0;
            if (!$s['pc_count']) {
                $s['status'] = 'empty';
            } else {
                $pct = $s['online_count'] / $s['pc_count'] * 100;
                $s['status'] = $pct >= $greenMin ? 'green' : ($pct <= $redMax ? 'red' : 'yellow');
            }
        }
        unset($s);
        return $stores;
    }

    // Кассы, чей IP по подсетям относится к другому магазину, чем тот, где они числятся.
    // $toStoreId — только те, что «принадлежат» этому магазину.
    private static function misplaced($toStoreId)
    {
        $db = Db::get();
        $candidates = array();
        $names = array();
        foreach ($db->query("SELECT id, name, subnets FROM stores WHERE subnets IS NOT NULL AND subnets <> ''")->fetchAll() as $s) {
            $names[$s['id']] = $s['name'];
            foreach ((array) self::parseSubnets($s['subnets']) as $cidr) {
                $candidates[] = array('id' => (int) $s['id'], 'cidr' => $cidr, 'priority' => 0);
            }
        }
        if (!$candidates) {
            return array();
        }

        $out = array();
        foreach ($db->query("
            SELECT p.id, p.hostname, p.display_name, p.last_ip, p.store_id, s.name AS store_name
            FROM pcs p JOIN stores s ON s.id = p.store_id
            WHERE p.last_ip IS NOT NULL AND p.last_ip <> ''
            ORDER BY s.name, p.hostname
        ")->fetchAll() as $pc) {
            $best = NetworkSiteMatcher::bestMatchingSite($pc['last_ip'], $candidates);
            if ($best === null || $best === (int) $pc['store_id'] || ($toStoreId !== null && $best !== $toStoreId)) {
                continue;
            }
            $out[] = array(
                'pc_id' => (int) $pc['id'], 'hostname' => $pc['hostname'], 'display_name' => $pc['display_name'], 'last_ip' => $pc['last_ip'],
                'from_store_id' => (int) $pc['store_id'], 'from_store' => $pc['store_name'],
                'to_store_id' => $best, 'to_store' => $names[$best],
            );
        }
        return $out;
    }
}
