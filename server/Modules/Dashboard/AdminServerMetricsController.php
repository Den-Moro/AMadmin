<?php

class AdminServerMetricsController
{
    // GET /admin/server-metrics — см. ServerMetrics для источников данных по режиму.
    public static function index()
    {
        AdminAuth::requireLogin();
        echo json_encode(ServerMetrics::collect());
    }
}
