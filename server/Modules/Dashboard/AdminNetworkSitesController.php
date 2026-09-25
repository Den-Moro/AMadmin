<?php

class AdminNetworkSitesController
{
    // GET /admin/network-sites — узлы со счётчиком хостов/онлайн и цветом статуса,
    // плюс общее число ПК без узла ("Без узла" — не отдельная запись в network_sites,
    // а просто "все ПК, которых нет ни в одном узле").
    public static function index()
    {
        AdminAuth::requireLogin();

        $db = Db::get();
        $window = Settings::int('online_window_seconds', 180);
        $onlineExpr = "(p.last_seen IS NOT NULL AND (julianday('now') - julianday(p.last_seen)) * 86400.0 <= {$window})";

        $sites = $db->query("
            SELECT s.id, s.name, s.cidr, s.priority,
                   COUNT(m.pc_id) AS host_count,
                   SUM(CASE WHEN {$onlineExpr} THEN 1 ELSE 0 END) AS online_count
            FROM network_sites s
            LEFT JOIN network_site_members m ON m.site_id = s.id
            LEFT JOIN pcs p ON p.id = m.pc_id
            GROUP BY s.id
            ORDER BY s.name
        ")->fetchAll();

        $greenMin = Settings::int('network_site_status_green_min_percent', 100);
        $redMax = Settings::int('network_site_status_red_max_percent', 0);
        foreach ($sites as &$site) {
            $total = (int) $site['host_count'];
            $online = (int) $site['online_count'];
            $site['host_count'] = $total;
            $site['online_count'] = $online;
            $site['offline_count'] = $total - $online;
            if ($total === 0) {
                $site['status'] = 'empty';
            } else {
                $pct = $online / $total * 100;
                if ($pct >= $greenMin) {
                    $site['status'] = 'green';
                } elseif ($pct <= $redMax) {
                    $site['status'] = 'red';
                } else {
                    $site['status'] = 'yellow';
                }
            }
        }
        unset($site);

        $unassigned = (int) $db->query(
            'SELECT COUNT(*) FROM pcs WHERE id NOT IN (SELECT pc_id FROM network_site_members)'
        )->fetchColumn();

        echo json_encode(array('sites' => $sites, 'unassigned_count' => $unassigned));
    }

    // POST /admin/network-sites   body: { name, cidr?, priority? }
    public static function store()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $body = json_decode(file_get_contents('php://input'), true);
        $name = isset($body['name']) ? trim($body['name']) : '';
        if ($name === '') {
            http_response_code(400);
            echo json_encode(array('error' => 'name_required'));
            return;
        }
        $cidr = isset($body['cidr']) ? trim($body['cidr']) : '';
        if ($cidr !== '' && !self::validCidr($cidr)) {
            http_response_code(400);
            echo json_encode(array('error' => 'invalid_cidr'));
            return;
        }

        $stmt = Db::get()->prepare('INSERT INTO network_sites (name, cidr, priority) VALUES (:name, :cidr, :priority)');
        $stmt->execute(array(
            'name'     => $name,
            'cidr'     => $cidr !== '' ? $cidr : null,
            'priority' => isset($body['priority']) ? (int) $body['priority'] : 0,
        ));

        $id = Db::get()->lastInsertId();
        Logger::info("Узел создан: id={$id} '{$name}' автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'id' => $id));
    }

    // PUT /admin/network-sites/{id}   body: { name?, cidr?, priority? }
    public static function update($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $body = json_decode(file_get_contents('php://input'), true);
        $fields = array();
        $params = array('id' => (int) $id);

        if (isset($body['name']) && trim($body['name']) !== '') {
            $fields[] = 'name = :name';
            $params['name'] = trim($body['name']);
        }
        if (array_key_exists('cidr', $body)) {
            $cidr = trim((string) $body['cidr']);
            if ($cidr !== '' && !self::validCidr($cidr)) {
                http_response_code(400);
                echo json_encode(array('error' => 'invalid_cidr'));
                return;
            }
            $fields[] = 'cidr = :cidr';
            $params['cidr'] = $cidr !== '' ? $cidr : null;
        }
        if (array_key_exists('priority', $body)) {
            $fields[] = 'priority = :priority';
            $params['priority'] = (int) $body['priority'];
        }
        if (!$fields) {
            http_response_code(400);
            echo json_encode(array('error' => 'nothing_to_update'));
            return;
        }

        Db::get()->prepare('UPDATE network_sites SET ' . implode(', ', $fields) . ' WHERE id = :id')->execute($params);
        echo json_encode(array('status' => 'ok'));
    }

    // DELETE /admin/network-sites/{id} — участники освобождаются каскадом (ON DELETE
    // CASCADE на network_site_members) и становятся «Без узла».
    public static function destroy($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $id = (int) $id;
        $stmt = Db::get()->prepare('DELETE FROM network_sites WHERE id = :id');
        $stmt->execute(array('id' => $id));

        Logger::info("Узел id={$id} удалён автором='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // POST /admin/network-sites/{id}/members   body: { pc_id | pc_ids }
    // Ручное назначение — всегда побеждает (manual=1), авто-пересчёт его не тронет.
    // У ПК только один узел (PRIMARY KEY(pc_id)) — INSERT ... ON CONFLICT переносит
    // хост из прежнего узла в этот, а не добавляет вторую запись.
    public static function addMember($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $body = json_decode(file_get_contents('php://input'), true);
        $ids = array();
        if (!empty($body['pc_id'])) {
            $ids[] = (int) $body['pc_id'];
        }
        if (!empty($body['pc_ids']) && is_array($body['pc_ids'])) {
            foreach ($body['pc_ids'] as $pcId) {
                $ids[] = (int) $pcId;
            }
        }
        $ids = array_values(array_unique(array_filter($ids)));
        if (!$ids) {
            http_response_code(400);
            echo json_encode(array('error' => 'pc_id_required'));
            return;
        }

        $siteId = (int) $id;
        $stmt = Db::get()->prepare('
            INSERT INTO network_site_members (site_id, pc_id, manual) VALUES (:site_id, :pc_id, 1)
            ON CONFLICT(pc_id) DO UPDATE SET site_id = :site_id2, manual = 1, assigned_at = CURRENT_TIMESTAMP
        ');
        foreach ($ids as $pcId) {
            $stmt->execute(array('site_id' => $siteId, 'pc_id' => $pcId, 'site_id2' => $siteId));
        }

        echo json_encode(array('status' => 'ok', 'added' => count($ids)));
    }

    // DELETE /admin/network-sites/{id}/members/{pcId} — переводит ПК в «Без узла».
    public static function removeMember($id, $pcId)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $stmt = Db::get()->prepare('DELETE FROM network_site_members WHERE site_id = :site_id AND pc_id = :pc_id');
        $stmt->execute(array('site_id' => (int) $id, 'pc_id' => (int) $pcId));
        echo json_encode(array('status' => 'ok'));
    }

    // POST /admin/network-sites/recompute — полный пересчёт авто-членства (manual=0)
    // по текущим last_ip всех ПК. Ручные назначения не трогает. Дополняет
    // Auth::heartbeat()'ый точечный пересчёт одного ПК на каждом опросе — этот нужен
    // для случая "правила узлов поменяли/добавили, пересчитать всех сразу".
    public static function recompute()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $db = Db::get();
        $sites = $db->query('SELECT id, cidr, priority FROM network_sites WHERE cidr IS NOT NULL')->fetchAll();

        $pcs = $db->query('
            SELECT p.id, p.last_ip, m.site_id AS current_site_id, m.manual
            FROM pcs p
            LEFT JOIN network_site_members m ON m.pc_id = p.id
        ')->fetchAll();

        $upsert = $db->prepare('
            INSERT INTO network_site_members (site_id, pc_id, manual) VALUES (:site_id, :pc_id, 0)
            ON CONFLICT(pc_id) DO UPDATE SET site_id = :site_id2, manual = 0, assigned_at = CURRENT_TIMESTAMP
        ');
        $delete = $db->prepare('DELETE FROM network_site_members WHERE pc_id = :pc_id AND manual = 0');

        $reassigned = 0;
        $unassigned = 0;

        $db->beginTransaction();
        try {
            foreach ($pcs as $pc) {
                if (!empty($pc['manual'])) {
                    continue;
                }
                $best = NetworkSiteMatcher::bestMatchingSite($pc['last_ip'], $sites);
                if ($best === null) {
                    if ($pc['current_site_id'] !== null) {
                        $delete->execute(array('pc_id' => $pc['id']));
                        $unassigned++;
                    }
                    continue;
                }
                if ($pc['current_site_id'] === null || (int) $pc['current_site_id'] !== $best) {
                    $upsert->execute(array('site_id' => $best, 'pc_id' => $pc['id'], 'site_id2' => $best));
                    $reassigned++;
                }
            }
            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            throw $e;
        }

        Logger::info("Пересчёт узлов: переназначено {$reassigned}, снято {$unassigned}, автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'reassigned' => $reassigned, 'unassigned' => $unassigned));
    }

    private static function validCidr($cidr)
    {
        $parts = explode('/', $cidr, 2);
        if (!filter_var($parts[0], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            return false;
        }
        if (isset($parts[1]) && (!ctype_digit($parts[1]) || (int) $parts[1] > 32)) {
            return false;
        }
        return true;
    }
}
