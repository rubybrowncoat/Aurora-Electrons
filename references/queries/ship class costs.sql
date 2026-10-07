--drop view vw_shipClasses;
--create view vw_shipClasses as

select 
	scl.ShipClassID 
	,scl.ClassName
	,scl.Commercial as IsCommercial
	,scl.Size
	,scl.Cost
	,ShipCounts.ShipCount
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
inner JOIN
(
	SELECT
		s.ShipClassID
		,count(*) as ShipCount
	FROM
		FCT_Ship as s
	group by
		s.ShipClassID
) as ShipCounts
on
	ShipCounts.ShipClassID = scl.ShipClassID
group by
	scl.ShipClassID