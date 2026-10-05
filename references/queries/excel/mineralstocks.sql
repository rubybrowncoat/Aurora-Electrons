--drop view vw_mineralStocks;
--create view vw_mineralStocks as

SELECT
	upper(substr(_rss.Name,1,3)) as Sys
	,_pop.PopName as BodyName
	,_pop.Duranium as Dur
	,_pop.Neutronium as Neu
	,_pop.Corbomite as Crb
	,_pop.Tritanium as Tri
	,_pop.Boronide as Bor
	,_pop.Mercassium as Mer
	,_pop.Vendarite as Ven
	,_pop.Sorium as Sor
	,_pop.Uridium as Uri
	,_pop.Corundium as Crn
	,_pop.Gallicite as Gal
	,_pop.PopulationID
			
		
		/*
		,_pop.PopName as BodyName
		,CASE when dpi.Name = 'Civilian Mining Complex' and _pop.PurchaseCivilianMinerals = 0 then 0 else 1 end as IsOwned
		,fm.MaterialID
		,fm.Amount
		,fm.Accessibility
		,fm.HalfOriginalAmount
		,fm.OriginalAcc
		,_pgov.Name as Governor
		,dpi.Name as MineType
		,_race.MineProduction
		,_pi.Amount * CASE WHEN _pi.PlanetaryInstallationID = 39 THEN 10 else 1 end as MineCount
		--,_pgov.CommandType --4 = sector, 3 = governor
		,_pgov.Name as Governor
		,ifnull(_pgovbon.BonusValue,1.0) as GovBonus
		,_sgov.Name as SectorLeader
		,ifnull(1+(_sgovbon.BonusValue-1)/4,1.0) as SectorBonus
		*/		
		--select *
	FROM
		FCT_Population as _pop
	inner JOIN
		(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace
	on
		CurrentRace.RaceID = _pop.RaceID
	left JOIN
		FCT_RaceSysSurvey as _rss
	on
		_rss.RaceID = _pop.RaceID
	AND
		_rss.SystemID = _pop.SystemID
--	group by
--		_pop.SystemID
	
		
/*
	inner JOIN
		FCT_Race as _race
	on
		_race.RaceID = _pop.RaceID
	inner JOIN
		FCT_SystemBody as sysbod
	on
		sysbod.SystemBodyID = _pop.SystemBodyID
	left join
		FCT_MineralDeposit as fm
	on
		fm.SystemBodyID = _pop.SystemBodyID	
	left JOIN
		FCT_PopulationInstallations as _pi
	on
		_pi.PopID = _pop.PopulationID
	left JOIN
		DIM_PlanetaryInstallation as dpi
	on
		dpi.PlanetaryInstallationID = _pi.PlanetaryInstallationID
	left JOIN
		FCT_Commander as _pgov
	on
		_pgov.PopLocationID = _pop.PopulationID
	AND
		_pgov.CommanderType = 2 --civilian admin
	AND
		_pgov.CommandType = 3 --governor
	left JOIN
		FCT_CommanderBonuses as _pgovbon
	on
		_pgovbon.CommanderID = _pgov.CommanderID
	AND
		_pgovbon.BonusID = 6 --mining bonus
	
	left JOIN
		FCT_SectorCommand as _seccom
	on
		_seccom.SectorCommandID = _rss.SectorID
	left JOIN
		FCT_Commander as _sgov
	on
		_sgov.CommandID = _seccom.SectorCommandID
	AND
		_sgov.CommanderType = 2 --civilian admin
	AND
		_sgov.CommandType = 4 --Sector
	left JOIN
		FCT_CommanderBonuses as _sgovbon
	on
		_sgovbon.CommanderID = _sgov.CommanderID
	AND
		_sgovbon.BonusID = 6 --mining bonus
	WHERE
	(
		dpi.Name in ('Mine','Automated Mine','Civilian Mining Complex')
	AND	
		_pi.Amount > 0
	)
) as surface
order by
	surface.BodyName
	,surface.MaterialID
	
	