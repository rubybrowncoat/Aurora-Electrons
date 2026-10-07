--DROP VIEW IF EXISTS "main"."vw_LagrangePointPlans";
--CREATE VIEW vw_LagrangePointPlans as

with CTE_sys as ( select '%' as sys) -- leave as '%' to select all
,CTE_LPPlan as
(
	select * from
	(select 138 as GameID) as x
	cross JOIN
	(
					select 'BAA-A2' as BodyName, -1 as Priority		-- -1: ignore, 0: not decided, 1+: higher is lower priority (generally year it might become useful)
		union all 	select 'BAB-A4' as BodyName, -1 as Priority		
		union all 	select 'BAB-A5' as BodyName, -1 as Priority
		union all 	select 'BAD-A1' as BodyName, -1 as Priority
		union all 	select 'BAD-A3' as BodyName, -1 as Priority
		union all 	select 'BEA-A2' as BodyName, -1 as Priority		
		union all 	select 'BEA-A3' as BodyName, -1 as Priority
		union all 	select 'BEA-A4' as BodyName, -1 as Priority
		union all 	select 'BEB-A2' as BodyName, 2130 as Priority		
		union all 	select 'BEB-A4' as BodyName, -1 as Priority
		union all 	select 'BEB-A6' as BodyName, 2130 as Priority
		union all 	select 'BEB-A7' as BodyName, -1 as Priority
		union all 	select 'BEB-A8' as BodyName, -1 as Priority
		union all 	select 'BEG-A2M9' as BodyName, -1 as Priority
		union all 	select 'BIA-A2' as BodyName, 9999 as Priority		
		union all 	select 'BIA-A3' as BodyName, 9999 as Priority		
		union all 	select 'BIB-A1' as BodyName, 9999 as Priority		
		union all 	select 'BIB-A2' as BodyName, 9999 as Priority		
		union all 	select 'BIB-A5' as BodyName, 9999 as Priority		
		union all 	select 'BIB-A6' as BodyName, 9999 as Priority		
		union all 	select 'BOB-A6' as BodyName, -1 as Priority
		union all 	select 'BUA-A3' as BodyName, -1 as Priority
		union all 	select 'BUA-A4' as BodyName, -1 as Priority
		union all 	select 'BUA-A5' as BodyName, -1 as Priority
		union all 	select 'DAB-B2' as BodyName, -1 as Priority
		union all 	select 'DAB-B3' as BodyName, -1 as Priority
		union all 	select 'DAB-B5' as BodyName, -1 as Priority
		union all 	select 'FAA-A3' as BodyName, -1 as Priority
		union all 	select 'FAA-A8' as BodyName, -1 as Priority
		union all 	select 'FAD-A1' as BodyName, 9999 as Priority
		union all 	select 'FEA-B3' as BodyName, -1 as Priority
		union all 	select 'FEB-A1' as BodyName, -1 as Priority
		union all 	select 'FEB-A2' as BodyName, -1 as Priority
		union all 	select 'FEB-A4' as BodyName, -1 as Priority
		union all 	select 'FEB-B1' as BodyName, -1 as Priority
		union all 	select 'FEB-B3' as BodyName, -1 as Priority
		union all 	select 'FEB-B4' as BodyName, -1 as Priority
		union all 	select 'HAA-A2' as BodyName, -1 as Priority
		union all 	select 'JAB-A1' as BodyName, 9999 as Priority
		union all 	select 'JAB-A2' as BodyName, 9999 as Priority
		union all 	select 'JAB-A4' as BodyName, 9999 as Priority
		union all 	select 'KAB-A1' as BodyName, 9999 as Priority
		union all 	select 'KAB-A3' as BodyName, 9999 as Priority
		union all 	select 'MAA-A2' as BodyName, -1 as Priority
		union all 	select 'MAA-A4' as BodyName, 9999 as Priority
	) as y
)

SELECT
	bn.BodyName
	,round(vtfp.OrbitYears,1) as OrbitYears
	--,round(sb.Year/365/24,1) as OrbitYears
	--,round(sb.DistanceToOrbitCentre*.15,1) as bkm
	,round(vtfp.OrbitalDistanceToStar*.15,1) as bkm
	,pln.Priority
	,round(5/sqrt(sb.mass),2) as LGYrs
	--,lp.LagrangePointID
	--,sb.*
FROM
	vw_const as c
inner JOIN
	FCT_RaceSysSurvey as rss on rss.RaceID = c.RaceID
inner JOIN
	FCT_SystemBody as sb on sb.SystemID = rss.SystemID
inner JOIN
	vw_tfplan as vtfp on vtfp.SystemBodyID = sb.SystemBodyID
left JOIN
	FCT_SystemBody as sb_parent
on
	sb_parent.SystemBodyID = sb.ParentBodyID
inner JOIN
	vw_BodyName as bn on bn.SystemBodyID = sb.SystemBodyID
left JOIN
	FCT_LagrangePoint as lp on lp.PlanetID = sb.SystemBodyID
left JOIN
	CTE_LPPlan as pln on pln.BodyName = bn.BodyName
WHERE
	lp.LagrangePointID is null
and
	sb.Mass >= 0.25
AND
	ifnull(pln.Priority,0) >= 0
AND
	bn.BodyName like (select sys from CTE_Sys)
order by 	
--	ifnull(pln.Priority,0) desc, 
	bn.BodyName