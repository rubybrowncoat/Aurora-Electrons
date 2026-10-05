with CTE_ShipClassMineralCost as (
	/*select 
	--sc.ShipClassID,sc.ClassName,sc.Cost,sc.Size from FCT_ShipClass as sc
	cc.ClassID
	,sum(cc.NumComponent * (sdc.Duranium + sdc.Neutronium + sdc.Corbomite + sdc.Tritanium + sdc.Boronide + sdc.Mercassium + sdc.Vendarite + sdc.Sorium + sdc.Uridium + sdc.Corundium + sdc.Gallicite))	as ClassMinerals
	from FCT_ClassComponent as cc
	inner join FCT_ShipDesignComponents as sdc
	on sdc.SDComponentID = cc.ComponentID
	group by cc.ClassID
	*/
	select 
	scl.ShipClassID as ClassID
	,scl.ClassName
	,scl.Size
	,scl.Cost
	,sum(cc.NumComponent * (sdc.Duranium + sdc.Neutronium + sdc.Corbomite + sdc.Tritanium + sdc.Boronide + sdc.Mercassium + sdc.Vendarite + sdc.Sorium + sdc.Uridium + sdc.Corundium + sdc.Gallicite))	as ClassMinerals
	,sum(cc.NumComponent *Duranium) as           Duranium
	,sum(cc.NumComponent *Neutronium ) as        Neutronium
	,sum(cc.NumComponent *Corbomite  ) as        Corbomite
	,sum(cc.NumComponent *Tritanium ) as         Tritanium
	,sum(cc.NumComponent *Boronide  ) as         Boronide 
	,sum(cc.NumComponent *Mercassium  ) as       Mercassium
	,sum(cc.NumComponent *Vendarite ) as         Vendarite
	,sum(cc.NumComponent *Sorium ) as            Sorium 
	,sum(cc.NumComponent *Uridium ) as           Uridium
	,sum(cc.NumComponent *Corundium) as          Corundium
	,sum(cc.NumComponent *Gallicite) as          Gallicite 
	,scl.MaintSupplies	
from 
	FCT_ShipClass as scl
inner JOIN
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as race
on	
	race.RaceID = scl.RaceID
inner JOIN
	FCT_ClassComponent as cc
on
	cc.ClassID = scl.ShipClassID
inner JOIN
	FCT_ShipDesignComponents as sdc
on
	sdc.SDComponentID = cc.ComponentID
group by
	scl.ShipClassID	
)

--select * from CTE_ShipClassMineralCost



SELECT
	yards.PopName
	,yards.ShipyardName
	,yards.YardType
	,yards.Capacity
	,yards.Slipways
	,yards.ActiveSlips
	,yards.TotalTonnage
	,yards.Governor
	,yards.GovBonus
	,yards.SectorLeader
	,yards.SectorBonus
	,CASE WHEN yards.ClassSize = 0 then yards.Capacity/50.0 else yards.ClassSize END as ClassSize
	,ClassCost
	,ClassMinerals
	,ClassDuranium
	,ClassNeutronium
	,ClassCorbomite
	,ClassTritanium
	,ClassBoronide 
	,ClassMercassium
	,ClassVendarite
	,ClassSorium 
	,ClassUridium
	,ClassCorundium
	,ClassGallicite 
	,ClassMaintSupplies
	
	
/*
	*/
FROM
(
SELECT
	_pop.PopName
	,yard.ShipyardName
	,yard.SYType as YardType
	,yard.Capacity
	,yard.Slipways
	,ifnull(yardtasks.ActiveSlips,0) as ActiveSlips
	,yard.Capacity * yard.Slipways as TotalTonnage
	,_pgov.Name as Governor
	,ifnull(_pgovbon.BonusValue,1.0) as GovBonus
	,_sgov.Name as SectorLeader
	,ifnull(1+(_sgovbon.BonusValue-1)/4,1.0) as SectorBonus
	,coalesce(retoolclass.Size,buildclass.Size,yard.CapacityTarget/50.0) as ClassSize	
	,coalesce(retoolclass.Cost,buildclass.Cost,'') as ClassCost
	,coalesce(retoolclassminerals.ClassMinerals,buildclassminerals.ClassMinerals,'') as ClassMinerals
	,coalesce(retoolclassminerals.Duranium,buildclassminerals.Duranium,'') as ClassDuranium
	,coalesce(retoolclassminerals.Neutronium,buildclassminerals.Neutronium,'') as ClassNeutronium
	,coalesce(retoolclassminerals.Corbomite,buildclassminerals.Corbomite,'') as ClassCorbomite
	,coalesce(retoolclassminerals.Tritanium,buildclassminerals.Tritanium,'') as ClassTritanium
	,coalesce(retoolclassminerals.Boronide ,buildclassminerals.Boronide ,'') as ClassBoronide 
	,coalesce(retoolclassminerals.Mercassium,buildclassminerals.Mercassium,'') as ClassMercassium
	,coalesce(retoolclassminerals.Vendarite,buildclassminerals.Vendarite,'') as ClassVendarite
	,coalesce(retoolclassminerals.Sorium ,buildclassminerals.Sorium ,'') as ClassSorium 
	,coalesce(retoolclassminerals.Uridium,buildclassminerals.Uridium,'') as ClassUridium
	,coalesce(retoolclassminerals.Corundium,buildclassminerals.Corundium,'') as ClassCorundium
	,coalesce(retoolclassminerals.Gallicite ,buildclassminerals.Gallicite ,'') as ClassGallicite 
	,coalesce(retoolclass.MaintSupplies,buildclass.MaintSupplies,'') as ClassMaintSupplies
	,yard.Capacity
	/*
	The base racial Shipbuilding Rate applies to ships of size 100 (5000 tons). If a ship is a different size, the rate of shipbuilding will be:
	Normal shipbuilding rate x (1+(((Class Size / 100) - 1)/2)) 
	*/
FROM
	FCT_Shipyard as yard
inner JOIN
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace
on
	CurrentRace.RaceID = yard.RaceID
inner JOIN
	FCT_Population as _pop
on
	_pop.PopulationID = yard.PopulationID
inner JOIN
	FCT_Race as _race
on
	_race.RaceID = _pop.RaceID
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
	_pgovbon.BonusID = 4 --shipbuilding
left JOIN
	FCT_RaceSysSurvey as _rss
on
	_rss.RaceID = _race.RaceID
AND
	_rss.SystemID = _pop.SystemID
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
	_sgovbon.BonusID = 4 --shipbuilding
left JOIN
	FCT_ShipClass as buildclass
on
	buildclass.ShipClassID = yard.BuildClassID
left JOIN
	FCT_ShipClass as retoolclass
on
	retoolclass.ShipClassID = yard.RetoolClassID
left JOIN
	CTE_ShipClassMineralCost as buildclassminerals
on
	buildclassminerals.ClassID = yard.BuildClassID
left JOIN
	CTE_ShipClassMineralCost as retoolclassminerals
on
	retoolclassminerals.ClassID = yard.RetoolClassID
left JOIN
	(select ShipyardID, count(*) as ActiveSlips from FCT_ShipyardTask where TaskTypeID = 0 group by ShipyardID) as yardtasks
on
	yardtasks.ShipyardID = yard.ShipyardID
WHERE
	_race.NPR = 0
) as yards