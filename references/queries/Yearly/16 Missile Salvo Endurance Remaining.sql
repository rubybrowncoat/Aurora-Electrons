with CTE_Params as
(
	select '' as MissileNameLike		-- use wildcards. leave blank to get all missile types.
)

SELECT
	distinct
	gd.GameDate
	,mt.Name
	,rss.Name as System
	,w.Name as Waypoint
	,date(gd.GameDate, concat('+' , ms.Endurance / 86400 , ' day')) as ExpiryDate
	,ms.Endurance / 86400.0 as EnduranceDays
	,ms.Endurance as EnduranceSeconds
	,ms.Endurance * ms.MissileSpeed / 1000.0 / 1000.0 as MkmRemaining
	,ms.SystemID
	--,ms.MissileSalvoID
	--,concat('+' , ms.Endurance / 86400 , ' day')
	--,	*
FROM
	vw_const as c cross join CTE_Params as p
cross join vw_gamedate as gd
inner JOIN
	FCT_MissileSalvo as ms
on
	ms.RaceID = c.RaceID
inner JOIN
	FCT_MissileType as mt
on
	mt.MissileID = ms.MissileID
AND
	(p.MissileNameLike = '' or mt.Name like p.MissileNameLike)
inner JOIN
	FCT_RaceSysSurvey as rss
on
	rss.RaceID = c.RaceID
AND
	rss.SystemID = ms.SystemID
left join
	FCT_Waypoint as w
on
	w.RaceID = c.RaceID
and
	w.Xcor = ms.Xcor
AND
	w.Ycor = ms.Ycor
--WHERE
--	ms.MissileSpeed = 0
order by
	ms.Endurance