with CTE_Params as
(
	select
		'bac%' as SystemName
)

SELECT
	ms.*
FROM
	CTE_Params as p
cross join vw_const as v
inner JOIN
	FCT_RaceSysSurvey as rss on rss.RaceID = v.RaceID and rss.Name like p.SystemName
inner JOIN
	FCT_MissileSalvo as ms
on
	ms.RaceID = v.RaceID
AND
	ms.SystemID = rss.SystemID
order by
	ms.Ycor, ms.Xcor
	
	
--
/*
with x as (select WaypointID, Xcor, Ycor from FCT_Waypoint where Name = 'BAC-A7')
update FCT_MissileSalvo set 
	TargetID = (select WaypointID from x)
	,TargetType = 22 
	,Xcor = (select Xcor from x)
	,Ycor = (select Ycor+1000000 from x)
where MissileSalvoID = 17290
--*/