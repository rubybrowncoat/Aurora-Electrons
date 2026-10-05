SELECT
	rss.Name
	,upper(substr(rss.Name,1,3)) as SYS
	,DATEtime('2025-01-01', '+' || cast(rss.DiscoveredTime/60/60/24 as varchar) || ' DAY') as DateDiscovered
FROM
	FCT_RaceSysSurvey as rss
WHERE
	rss.RaceID = 299
order by
	rss.DiscoveredTime