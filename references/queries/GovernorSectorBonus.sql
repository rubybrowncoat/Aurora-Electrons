--query for net planetary bonuses for governors and sector commanders
--select * from vw_GovernorSectorBonus
--drop view vw_GovernorSectorBonus; 
--create view vw_GovernorSectorBonus as 


WITH const AS 
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0)

,CTE_CivilianAdministratorBonus as
(
	SELECT
		cdr.CommanderID
		,cdr.Name
		,cdr.CommandType
		,cdr.PopLocationID
		,1 + sum(CASE WHEN cdrbon.BonusID = 4	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_Shipbuilding
		,1 + sum(CASE WHEN cdrbon.BonusID = 5	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_Production
		,1 + sum(CASE WHEN cdrbon.BonusID = 6	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_Mining
		,1 + sum(CASE WHEN cdrbon.BonusID = 8	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_PopulationGrowth
		,1 + sum(CASE WHEN cdrbon.BonusID = 9	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_Terraforming
		,1 + sum(CASE WHEN cdrbon.BonusID = 11	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_GroundConstruction
		,1 + sum(CASE WHEN cdrbon.BonusID = 14	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_PoliticalReliability
		,1 + sum(CASE WHEN cdrbon.BonusID = 20	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_WealthCreation
		,1 + sum(CASE WHEN cdrbon.BonusID = 24	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_Logistics
	FROM
		FCT_Commander as cdr		
	inner JOIN
		FCT_CommanderBonuses as cdrbon
	on
		cdrbon.CommanderID = cdr.CommanderID
	WHERE
		cdr.CommanderType = 2 --civilian admin
	AND
		cdr.CommandType = 3 --governor
	group by
		cdr.CommanderID
		
	UNION ALL
	
	SELECT
		cdr.CommanderID
		,cdr.Name
		,cdr.CommandType
		,cdr.PopLocationID
		,1 + sum(CASE WHEN cdrbon.BonusID = 4	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_Shipbuilding
		,1 + sum(CASE WHEN cdrbon.BonusID = 5	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_Production
		,1 + sum(CASE WHEN cdrbon.BonusID = 6	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_Mining
		,1 + sum(CASE WHEN cdrbon.BonusID = 8	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_PopulationGrowth
		,1 + sum(CASE WHEN cdrbon.BonusID = 9	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_Terraforming
		,1 + sum(CASE WHEN cdrbon.BonusID = 11	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_GroundConstruction
		,1 + sum(CASE WHEN cdrbon.BonusID = 14	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_PoliticalReliability
		,1 + sum(CASE WHEN cdrbon.BonusID = 20	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_WealthCreation
		,1 + sum(CASE WHEN cdrbon.BonusID = 24	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_Logistics
		--,*
	FROM
		FCT_Commander as cdr
	inner JOIN
		FCT_CommanderBonuses as cdrbon
	on
		cdrbon.CommanderID = cdr.CommanderID
	WHERE
		cdr.CommanderType = 2 --civilian admin
	AND
		cdr.CommandType = 4 --sector	
	group by
		cdr.CommanderID
)

--select * from CTE_CivilianAdministratorBonus


SELECT
	_pop.PopulationID
	,IfNull(cteGov.Bonus_Shipbuilding			,1) * IfNull(cteSec.Bonus_Shipbuilding			,1) as NetBonus_Shipbuilding		
	,IfNull(cteGov.Bonus_Production             ,1) * IfNull(cteSec.Bonus_Production            ,1) as NetBonus_Production           
	,IfNull(cteGov.Bonus_Mining                 ,1) * IfNull(cteSec.Bonus_Mining                ,1) as NetBonus_Mining               
	,IfNull(cteGov.Bonus_PopulationGrowth       ,1) * IfNull(cteSec.Bonus_PopulationGrowth      ,1) as NetBonus_PopulationGrowth     
	,IfNull(cteGov.Bonus_Terraforming           ,1) * IfNull(cteSec.Bonus_Terraforming          ,1) as NetBonus_Terraforming         
	,IfNull(cteGov.Bonus_GroundConstruction     ,1) * IfNull(cteSec.Bonus_GroundConstruction    ,1) as NetBonus_GroundConstruction   
	,IfNull(cteGov.Bonus_PoliticalReliability   ,1) * IfNull(cteSec.Bonus_PoliticalReliability  ,1) as NetBonus_PoliticalReliability 
	,IfNull(cteGov.Bonus_WealthCreation         ,1) * IfNull(cteSec.Bonus_WealthCreation        ,1) as NetBonus_WealthCreation       
	,IfNull(cteGov.Bonus_Logistics              ,1) * IfNull(cteSec.Bonus_Logistics             ,1) as NetBonus_Logistics 
	,cteGov.*
	,cteSec.*

FROM
	FCT_Population as _pop
inner JOIN
	const as c on c.RaceID = _pop.RaceID
left JOIN
	CTE_CivilianAdministratorBonus as cteGov
on
	cteGov.PopLocationID = _pop.PopulationID
AND
	cteGov.CommandType = 3
left JOIN
	FCT_RaceSysSurvey as _rss
on
	_rss.RaceID = c.RaceID
AND
	_rss.SystemID = _pop.SystemID
left JOIN
	FCT_SectorCommand as _seccom
on
	_seccom.SectorCommandID = _rss.SectorID
left JOIN
	CTE_CivilianAdministratorBonus as cteSec
on
	cteSec.PopLocationID = _seccom.PopulationID
AND
	cteSec.CommandType = 4
	

ORDER BY _pop.PopulationID