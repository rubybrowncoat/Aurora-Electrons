--drop view vw_orbitalMining; 
--create view vw_orbitalMining as

with x as (select 
	max(GameID) as mygameid	from FCT_Game
),
CTE_AdminCommands as 
(
	select 
		nac.RaceID
		,*		
		,nact.Industrial as AdminPct
		,ifnull(cmdrbon.BonusValue,0.0) as CmdrBonus
		,1+(nact.Industrial * (ifnull(cmdrbon.BonusValue,1.0)-1)) as NetBonus
	FROM
		FCT_NavalAdminCommand as nac
	inner JOIN
		(	select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace
	on
		CurrentRace.RaceID = nac.RaceID
	left JOIN
		FCT_Commander as cmdr
	on
		cmdr.CommandID = nac.NavalAdminCommandID
	left JOIN
		FCT_CommanderBonuses as cmdrbon
	on
		cmdrbon.CommanderID = cmdr.CommanderID
	AND
		cmdrbon.BonusID = 6
	inner JOIN
		DIM_NavalAdminCommandType as nact
	on
		nact.CommandTypeID = nac.AdminCommandTypeID
),
CTE_MiningAdminBonus as
(
	SELECT
		nac.AdminCommandName
		,nac.NavalAdminCommandID
		,nac.NetBonus * ifnull(p_1.NetBonus,1.0) * ifnull(p_2.NetBonus,1.0) * ifnull(p_3.NetBonus,1.0) * ifnull(p_4.NetBonus,1.0) * ifnull(p_5.NetBonus,1.0) * ifnull(p_6.NetBonus,1.0) * ifnull(p_7.NetBonus,1.0) as TotalBonus 
		
	FROM
		CTE_AdminCommands as nac	
	inner JOIN
			FCT_Race as _race
		on
			_race.RaceID = nac.RaceID
	left JOIN
		CTE_AdminCommands as p_1
	on
		p_1.NavalAdminCommandID = nac.ParentAdminCommandID 
	left JOIN
		CTE_AdminCommands as p_2
	on
		p_2.NavalAdminCommandID = p_1.ParentAdminCommandID 
	left JOIN
		CTE_AdminCommands as p_3
	on
		p_3.NavalAdminCommandID = p_2.ParentAdminCommandID
	left JOIN
		CTE_AdminCommands as p_4
	on
		p_4.NavalAdminCommandID = p_3.ParentAdminCommandID
	left JOIN
		CTE_AdminCommands as p_5
	on
		p_5.NavalAdminCommandID = p_4.ParentAdminCommandID
	left JOIN
		CTE_AdminCommands as p_6
	on
		p_6.NavalAdminCommandID = p_5.ParentAdminCommandID
	left JOIN
		CTE_AdminCommands as p_7
	on
		p_7.NavalAdminCommandID = p_6.ParentAdminCommandID
	WHERE
		_race.NPR = 0
)

SELECT
	orbital.Sys
	,orbital.BodyName
	, orbital.MaterialID
	, orbital.MiningModules * orbital.MineProduction * orbital.CmdrBonus * orbital.Accessibility * orbital.AdminBonus as MiningRate
	, orbital.FleetName
	, orbital.ShipName
	, orbital.MiningModules
	, orbital.MineProduction
	, orbital.CmdrBonus
	, orbital.AdminBonus
	, orbital.Accessibility
	, round(orbital.Amount/1000,1) as AmountK
	
	/*
	surface.MineCount 
	, surface.MineType
	, surface.MineProduction
	, surface.GovBonus 
	, surface.SectorBonus 
	, surface.MaterialID
	, surface.Accessibility 
	, surface.MineCount * surface.MineProduction * surface.GovBonus * surface.SectorBonus * surface.Accessibility as MiningRate
	, *
	*/
	--*
FROM
(
	SELECT
		upper(substr(_rss.Name,1,3)) as Sys
		,pop.PopName as BodyName
		,fm.MaterialID
		,fm.Amount
		,fm.Accessibility
		,fm.HalfOriginalAmount
		,fm.OriginalAcc
		,_race.MineProduction
		,_flt.FleetName
		,_ship.ShipName
		,_class.MiningModules
		,_cmdr.Name as CommanderName
		,ifnull(_cmdrbon.BonusValue,1.0) as CmdrBonus
		,adm.TotalBonus as AdminBonus
		--,_pgov.CommandType --4 = sector, 3 = governor
		--,_pgovbon.*
		--,_class.*
		--,_flt.*
		--,_cmdr.*
		,x.*
		
	FROM
		FCT_MineralDeposit as fm
	inner JOIN
		x
	on
		x.mygameid = fm.GameID
	inner JOIN
		FCT_SystemBody as sysbod
	on
		sysbod.SystemBodyID = fm.SystemBodyID
	inner JOIN
		FCT_Population as Pop
	on
		pop.SystemBodyID = fm.SystemBodyID
	inner JOIN
		FCT_Fleet as _flt
	on
		_flt.OrbitBodyID = sysbod.SystemBodyID
	inner JOIN
		FCT_Race as _race
	on
		_race.RaceID = _flt.RaceID
	inner JOIN
		FCT_Ship as _ship
	on
		_ship.FleetID = _flt.FleetID
	inner JOIN
		FCT_ShipClass as _class
	on
		_class.ShipClassID = _ship.ShipClassID
	left JOIN
		FCT_Commander as _cmdr
	on
		_cmdr.CommandID = _ship.ShipID
	AND
		_cmdr.CommanderType = 0
	left JOIN
		FCT_CommanderBonuses as _cmdrbon
	on
		_cmdrbon.CommanderID = _cmdr.CommanderID
	AND
		_cmdrbon.BonusID = 6 --mining bonus
	inner JOIN
		CTE_MiningAdminBonus as adm
	on
		adm.NavalAdminCommandID = _flt.ParentCommandID	
	left JOIN
		FCT_RaceSysSurvey as _rss
	on
		_rss.RaceID = _race.RaceID
	AND
		_rss.SystemID = sysbod.SystemID
		
	WHERE
		_race.NPR = 0
	AND
		_class.MiningModules > 0
	AND
		_flt.FleetName <> '__Shipyard'
) as orbital	
/*
group by
	orbital.BodyName
	,orbital.MaterialID
*/